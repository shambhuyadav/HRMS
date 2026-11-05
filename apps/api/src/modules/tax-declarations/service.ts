// Tax declarations and investment proofs: capture and review only (FR-036 "investment declaration checking"; FR-108; H3 TN08,
// TN09; H4; BR-053; BR-054; BR-055; DF05; F4; B7). Migration 0128.
//
// No tax is calculated. Nothing here writes a payroll input, a line or a record, and the calculation never reads these tables,
// so accepting a declaration or a proof gives no relief (H3 "no automatic tax relief"; FR-108 "does not silently create a
// deduction allowance"; "post-lock acceptance cannot rewrite processed payroll"). What accepted inputs do in a payroll valuation
// waits for the owner and a real rule pack.
//
// A rule pack lists a fiscal period's dates, cutoff, currency, regimes and categories; it holds no rate and none is seeded. Until
// one is activated the feature answers NOT_CONFIGURED. Amounts and the chosen regime are sealed (security/field-crypto.ts) and
// never reach audit records, events or notices. The employee works in the Employee OWN context only (BR-055); a reviewer from the
// explicit list decides, never about their own record, with an employee-visible explanation kept apart from the private reason.
import { randomUUID } from 'node:crypto';
import { type Paging, pageOf } from '../../db/paging.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import { openJson, sealJson } from '../../security/field-crypto.js';
import { type AccessGrant, employeeScopePredicate, SqlParams } from '../access/authorize.js';
import { assertUsableEvidence, EVIDENCE_JSON, linkEvidence, revisionEvidence } from '../employee/evidence.js';
import {
  actorOf,
  advisoryLock,
  assertInScope,
  assertNotSelf,
  audit,
  checkAmount,
  emit,
  newTransaction,
  optionalKey,
  priorDecision,
  requireCompanyScope,
  requireDate,
  requireText,
  requireVerifiedEvidence,
  taskIsPending,
  taskTransaction,
  unrestricted,
  userIsEmployee,
} from '../payroll/common.js';
import { ownEmployee } from '../payroll-outputs/payslips.js';
import { decideTask, lockTransaction, myOpenTasks, startApproval } from '../workflow/engine.js';

export const DECLARATION_KIND = 'tax_declaration';
export const PROOF_KIND = 'tax_proof';
const LIST_CAP = 200;

export const NOT_CONFIGURED_MESSAGE = 'Your company has not activated a tax rule pack yet, so tax declarations and investment proofs cannot be entered. Nothing is needed from you for now.';
const CALCULATION = { status: 'NOT_CONFIGURED', message: 'No tax is calculated here. Accepting a declaration or proof gives no relief by itself and changes no payroll.' } as const;

const notConfigured = () => new HttpError(409, 'NOT_CONFIGURED', NOT_CONFIGURED_MESSAGE, { code: 'TAX_RULE_PACK_NOT_CONFIGURED', needs: ['activated tax rule pack for the fiscal period (H3, F4)'] });
const stale = (): never => {
  throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');
};

// ---------------------------------------------------------------------------------------------------------------
// Rule pack registry (payroll configuration duties; no calculation content)
// ---------------------------------------------------------------------------------------------------------------

export interface PackInput {
  code: string;
  fiscalPeriodCode: string;
  periodStart: string;
  periodEnd: string;
  cutoffDate: string;
  currencyCode: string;
  currencyMinorUnit: number;
  sourceReference: string;
  validationReference: string;
  regimes: { code: string; name: string; categories: { code: string; name: string }[] }[];
}

const PACK_VIEW = `select p.id, p.code, p.revision, p.fiscal_period_code as "fiscalPeriodCode", to_char(p.period_start, 'YYYY-MM-DD') as "periodStart", to_char(p.period_end, 'YYYY-MM-DD') as "periodEnd",
    to_char(p.cutoff_date, 'YYYY-MM-DD') as "cutoffDate", p.currency_code as "currencyCode", p.currency_minor_unit as "currencyMinorUnit", p.source_reference as "sourceReference",
    p.validation_reference as "validationReference", p.state, p.created_by as "createdBy", p.activated_by as "activatedBy", p.activated_at as "activatedAt", p.version,
    coalesce((select json_agg(json_build_object('code', r.code, 'name', r.name,
                'categories', coalesce((select json_agg(json_build_object('code', c.code, 'name', c.name) order by c.code)
                                          from tax_rule_pack_category c where c.company_id = r.company_id and c.pack_id = r.pack_id and c.regime_code = r.code), '[]'::json)) order by r.code)
                from tax_rule_pack_regime r where r.company_id = p.company_id and r.pack_id = p.id), '[]'::json) as regimes
  from tax_rule_pack p`;

interface Pack {
  id: string;
  code: string;
  revision: number;
  fiscalPeriodCode: string;
  cutoffDate: string;
  currencyCode: string;
  currencyMinorUnit: number;
  state: string;
  regimes: { code: string; name: string; categories: { code: string; name: string }[] }[];
}

export async function listPacks(db: Queryable, grant: AccessGrant) {
  const items = (await db.query(`${PACK_VIEW} where p.company_id = $1 order by p.fiscal_period_code desc, p.code, p.revision desc`, [grant.companyId])).rows;
  return { items, calculation: CALCULATION };
}

const CODE = /^[A-Z][A-Z0-9_]{0,39}$/;

export async function createPack(tx: Queryable, grant: AccessGrant, input: PackInput) {
  requireCompanyScope(grant);
  const code = input.code.trim().toUpperCase();
  if (!CODE.test(code)) throw new HttpError(422, 'INVALID_CODE', 'A rule pack code is upper-case letters, digits and underscores', { field: 'code' });
  const periodStart = requireDate(input.periodStart, 'period start');
  const periodEnd = requireDate(input.periodEnd, 'period end');
  const cutoffDate = requireDate(input.cutoffDate, 'cutoff date');
  if (periodEnd <= periodStart) throw new HttpError(422, 'INVALID_PERIOD', 'The fiscal period must end after it starts');
  const regimeCodes = input.regimes.map((r) => r.code);
  const categories = input.regimes.flatMap((r) => r.categories.map((c) => `${r.code}:${c.code}`));
  if (new Set(regimeCodes).size !== regimeCodes.length || new Set(categories).size !== categories.length) throw new HttpError(422, 'DUPLICATE_CODE', 'A regime, and a category within its regime, appears once');
  if ([...regimeCodes, ...input.regimes.flatMap((r) => r.categories.map((c) => c.code))].some((c) => !CODE.test(c))) {
    throw new HttpError(422, 'INVALID_CODE', 'Regime and category codes are upper-case letters, digits and underscores');
  }
  await advisoryLock(tx, `tax_rule_pack:${grant.companyId}:${code}`);
  await reassertAccess(tx, grant, 'payroll_config', 'manage', ['operational']);
  const id = (
    await tx.query<{ id: string }>(
      `insert into tax_rule_pack (company_id, code, revision, fiscal_period_code, period_start, period_end, cutoff_date, currency_code, currency_minor_unit, source_reference, validation_reference, state, created_by, updated_by)
       select $1, $2, coalesce(max(revision), 0) + 1, $3, $4, $5, $6, $7, $8, $9, $10, 'DRAFT', $11, $11 from tax_rule_pack where company_id = $1 and code = $2
       returning id`,
      [
        grant.companyId,
        code,
        input.fiscalPeriodCode,
        periodStart,
        periodEnd,
        cutoffDate,
        input.currencyCode.trim().toUpperCase(),
        input.currencyMinorUnit,
        requireText(input.sourceReference, 'source reference', 500, 'SOURCE_REQUIRED'),
        requireText(input.validationReference, 'validation reference', 500, 'VALIDATION_REQUIRED'),
        grant.userId,
      ],
    )
  ).rows[0]!.id;
  for (const r of input.regimes) {
    await tx.query(`insert into tax_rule_pack_regime (company_id, pack_id, code, name, created_by) values ($1, $2, $3, $4, $5)`, [grant.companyId, id, r.code, r.name, grant.userId]);
    for (const c of r.categories) {
      await tx.query(`insert into tax_rule_pack_category (company_id, pack_id, regime_code, code, name, created_by) values ($1, $2, $3, $4, $5, $6)`, [grant.companyId, id, r.code, c.code, c.name, grant.userId]);
    }
  }
  await audit(tx, actorOf(grant), 'tax_rule_pack', id, 'CREATE', null, { operational: { code, fiscalPeriodCode: input.fiscalPeriodCode, regimes: regimeCodes.length, categories: categories.length, state: 'DRAFT' } });
  return (await tx.query(`${PACK_VIEW} where p.company_id = $1 and p.id = $2`, [grant.companyId, id])).rows[0];
}

export async function activatePack(tx: Queryable, grant: AccessGrant, id: string, input: { expectedVersion: number }) {
  requireCompanyScope(grant);
  const p = (
    await tx.query<{ fiscal_period_code: string; state: string; created_by: string | null; version: number }>(
      `select fiscal_period_code, state, created_by, version from tax_rule_pack where company_id = $1 and id = $2 for update`,
      [grant.companyId, id],
    )
  ).rows[0];
  if (!p) throw notFound();
  if (p.version !== input.expectedVersion) stale();
  if (p.state !== 'DRAFT') throw new HttpError(409, 'INVALID_STATE', 'Only a draft rule pack can be activated');
  // DF05/F4: validated and activated independently.
  if (p.created_by === grant.userId) throw new HttpError(403, 'SELF_APPROVAL', 'A rule pack is activated by someone other than its author');
  await advisoryLock(tx, `tax_rule_pack_period:${grant.companyId}:${p.fiscal_period_code}`);
  await reassertAccess(tx, grant, 'payroll_config', 'activate', ['operational']);
  await tx.query(`update tax_rule_pack set state = 'RETIRED', updated_by = $3 where company_id = $1 and fiscal_period_code = $2 and state = 'ACTIVE'`, [grant.companyId, p.fiscal_period_code, grant.userId]);
  await tx.query(`update tax_rule_pack set state = 'ACTIVE', activated_by = $3, activated_at = now(), updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, id, grant.userId]);
  await audit(tx, actorOf(grant), 'tax_rule_pack', id, 'ACTIVATE', { operational: { state: 'DRAFT' } }, { operational: { state: 'ACTIVE', fiscalPeriodCode: p.fiscal_period_code } });
  return (await tx.query(`${PACK_VIEW} where p.company_id = $1 and p.id = $2`, [grant.companyId, id])).rows[0];
}

/** H3: whether the tabs can serve anything: a pack is or was active. Used by the My ESS index. */
export async function anyTaxRulePackActivated(db: Queryable, companyId: string): Promise<boolean> {
  return ((await db.query(`select 1 from tax_rule_pack where company_id = $1 and state in ('ACTIVE', 'RETIRED') limit 1`, [companyId])).rowCount ?? 0) > 0;
}

async function activePack(db: Queryable, companyId: string, fiscalPeriodCode: string, lock = false): Promise<Pack> {
  const id = (await db.query<{ id: string }>(`select id from tax_rule_pack where company_id = $1 and fiscal_period_code = $2 and state = 'ACTIVE' ${lock ? 'for share' : ''}`, [companyId, fiscalPeriodCode])).rows[0]?.id;
  if (!id) throw notConfigured();
  return (await db.query<Pack>(`${PACK_VIEW} where p.company_id = $1 and p.id = $2`, [companyId, id])).rows[0]!;
}

function requireOpen(pack: Pack, today: string): void {
  // FR-108 "cutoff ... checked"; H3 TN08. The date is the pack's; nothing is defaulted.
  if (today > pack.cutoffDate) throw new HttpError(409, 'TAX_CUTOFF_PASSED', 'The cutoff for this fiscal period has passed', { cutoffDate: pack.cutoffDate });
}

// ---------------------------------------------------------------------------------------------------------------
// Sealed values
// ---------------------------------------------------------------------------------------------------------------

interface SealedDeclaration {
  regimeCode: string;
  lines: { categoryCode: string; amount: string }[];
}
interface SealedProof {
  claimedAmount: string;
}
interface SealedProofDecision {
  acceptedAmount: string;
  rejectedAmount: string;
}

const binding = (purpose: string, companyId: string, employeeId: string, id: string) => ({ purpose, companyId, ownerId: employeeId, recordId: id });
const declarationBinding = (c: string, e: string, id: string) => binding('tax_declaration.values', c, e, id);
const proofBinding = (c: string, e: string, id: string) => binding('tax_proof.values', c, e, id);
const decisionBinding = (c: string, e: string, id: string) => binding('tax_proof.decision', c, e, id);

/** H3 "selected regime/categories only from active rule pack"; amounts in the pack's currency minor unit. */
function checkedValues(pack: Pack, input: { regimeCode: string; lines: { categoryCode: string; amount: string }[] }): SealedDeclaration {
  const regime = pack.regimes.find((r) => r.code === input.regimeCode);
  if (!regime) throw new HttpError(422, 'UNKNOWN_REGIME', 'That regime is not in the active rule pack', { field: 'regimeCode' });
  const allowed = new Set(regime.categories.map((c) => c.code));
  const seen = new Set<string>();
  const lines = input.lines.map((l) => {
    if (!allowed.has(l.categoryCode)) throw new HttpError(422, 'UNKNOWN_CATEGORY', 'That category is not in the selected regime of the active rule pack', { field: 'categoryCode' });
    if (seen.has(l.categoryCode)) throw new HttpError(422, 'DUPLICATE_CATEGORY', 'A category appears once in a declaration', { field: 'categoryCode' });
    seen.add(l.categoryCode);
    return { categoryCode: l.categoryCode, amount: checkAmount(l.amount, pack.currencyMinorUnit, { field: 'amount' }) };
  });
  return { regimeCode: regime.code, lines };
}

// ---------------------------------------------------------------------------------------------------------------
// TN08 the employee's own declaration (Employee OWN context; own-ESS group `tax`)
// ---------------------------------------------------------------------------------------------------------------

interface DeclarationRow {
  id: string;
  employee_id: string;
  transaction_id: string;
  rule_pack_id: string;
  fiscal_period_code: string;
  sealed_values: string;
  state: string;
  version: number;
}

const DECLARATION_ROW = `id, employee_id, transaction_id, rule_pack_id, fiscal_period_code, sealed_values, state, version`;

const DECLARATION_VIEW = `select d.id, d.employee_id as "employeeId", d.transaction_id as "transactionId", d.rule_pack_id as "rulePackId", d.fiscal_period_code as "fiscalPeriodCode", d.sealed_values as "sealedValues",
    p.code as "rulePackCode", p.revision as "rulePackRevision", to_char(p.cutoff_date, 'YYYY-MM-DD') as "cutoffDate", p.currency_code as "currencyCode", p.state as "rulePackState",
    d.state, d.follows_declaration_id as "followsDeclarationId", d.submitted_at as "submittedAt", d.decided_at as "decidedAt", d.employee_explanation as "employeeExplanation", d.created_at as "createdAt", d.version,
    e.employee_code as "employeeCode", e.display_name as "employeeName"
  from tax_declaration d
  join tax_rule_pack p on p.company_id = d.company_id and p.id = d.rule_pack_id
  join employee e on e.company_id = d.company_id and e.id = d.employee_id`;

interface DeclarationView {
  id: string;
  employeeId: string;
  sealedValues: string;
  state: string;
  [key: string]: unknown;
}

function openDeclaration(companyId: string, d: DeclarationView) {
  const { sealedValues, ...rest } = d;
  const values = openJson<SealedDeclaration>(sealedValues, declarationBinding(companyId, d.employeeId, d.id));
  return { ...rest, regimeCode: values.regimeCode, lines: values.lines };
}

export async function ownDeclarations(db: Queryable, grant: AccessGrant, paging: Paging) {
  const employeeId = ownEmployee(grant);
  const configured = await anyTaxRulePackActivated(db, grant.companyId);
  const packs = (await db.query(`${PACK_VIEW} where p.company_id = $1 and p.state = 'ACTIVE' order by p.fiscal_period_code desc`, [grant.companyId])).rows;
  const page = await pageOf<DeclarationView>(db, `${DECLARATION_VIEW} where d.company_id = $1 and d.employee_id = $2`, [grant.companyId, employeeId], '"createdAt" desc, id', paging, LIST_CAP);
  return {
    ...page,
    items: page.items.map((d) => openDeclaration(grant.companyId, d)),
    configuration: configured ? { status: 'ACTIVE' as const } : { status: 'NOT_CONFIGURED' as const, code: 'TAX_RULE_PACK_NOT_CONFIGURED', message: NOT_CONFIGURED_MESSAGE },
    // Only what an employee chooses from; never a source or validation reference.
    openPeriods: (packs as (Pack & { periodStart: string; periodEnd: string })[]).map((p) => ({
      rulePackId: p.id,
      fiscalPeriodCode: p.fiscalPeriodCode,
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
      cutoffDate: p.cutoffDate,
      currencyCode: p.currencyCode,
      cutoffPassed: grant.businessDate > p.cutoffDate,
      regimes: p.regimes,
    })),
    calculation: CALCULATION,
  };
}

async function ownDeclarationView(db: Queryable, grant: AccessGrant, employeeId: string, id: string) {
  const d = (await db.query<DeclarationView>(`${DECLARATION_VIEW} where d.company_id = $1 and d.id = $2 and d.employee_id = $3`, [grant.companyId, id, employeeId])).rows[0];
  if (!d) throw notFound();
  return openDeclaration(grant.companyId, d);
}

const reassertOwn = (tx: Queryable, grant: AccessGrant, action: 'submit') => reassertAccess(tx, grant, 'own_tax', action, ['tax']);

export interface DeclarationInput {
  regimeCode: string;
  lines: { categoryCode: string; amount: string }[];
}

export async function createOwnDeclaration(tx: Queryable, grant: AccessGrant, input: DeclarationInput & { fiscalPeriodCode: string }) {
  const employeeId = ownEmployee(grant);
  await advisoryLock(tx, `tax_declaration:${grant.companyId}:${employeeId}`);
  await reassertOwn(tx, grant, 'submit');
  const pack = await activePack(tx, grant.companyId, input.fiscalPeriodCode, true);
  requireOpen(pack, grant.businessDate);
  const prior = (
    await tx.query<{ id: string; state: string }>(`select id, state from tax_declaration where company_id = $1 and employee_id = $2 and fiscal_period_code = $3 order by created_at desc`, [
      grant.companyId,
      employeeId,
      input.fiscalPeriodCode,
    ])
  ).rows;
  const live = prior.find((p) => p.state === 'DRAFT' || p.state === 'SUBMITTED' || p.state === 'ACCEPTED');
  if (live) throw new HttpError(409, 'DECLARATION_EXISTS', 'You already have a declaration for this fiscal period', { declarationId: live.id });
  const values = checkedValues(pack, input);
  const id = randomUUID();
  const transactionId = await newTransaction(tx, grant.companyId, DECLARATION_KIND, employeeId, 'DRAFT', grant.userId);
  await tx.query(
    `insert into tax_declaration (id, company_id, employee_id, transaction_id, rule_pack_id, fiscal_period_code, sealed_values, line_count, state, follows_declaration_id, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'DRAFT', $9, $10, $10)`,
    [id, grant.companyId, employeeId, transactionId, pack.id, input.fiscalPeriodCode, sealJson(values, declarationBinding(grant.companyId, employeeId, id)), values.lines.length, prior[0]?.id ?? null, grant.userId],
  );
  await audit(tx, actorOf(grant), 'tax_declaration', id, 'CREATE', null, { operational: { fiscalPeriodCode: input.fiscalPeriodCode, rulePackId: pack.id, lineCount: values.lines.length, state: 'DRAFT' } });
  return ownDeclarationView(tx, grant, employeeId, id);
}

async function lockOwnDeclaration(tx: Queryable, grant: AccessGrant, employeeId: string, id: string): Promise<DeclarationRow> {
  const t = (await tx.query<{ transaction_id: string }>(`select transaction_id from tax_declaration where company_id = $1 and id = $2 and employee_id = $3`, [grant.companyId, id, employeeId])).rows[0];
  if (!t) throw notFound();
  await lockTransaction(tx, t.transaction_id);
  return (await tx.query<DeclarationRow>(`select ${DECLARATION_ROW} from tax_declaration where company_id = $1 and id = $2 for update`, [grant.companyId, id])).rows[0]!;
}

export async function updateOwnDeclaration(tx: Queryable, grant: AccessGrant, id: string, input: DeclarationInput & { expectedVersion: number }) {
  const employeeId = ownEmployee(grant);
  const d = await lockOwnDeclaration(tx, grant, employeeId, id);
  await reassertOwn(tx, grant, 'submit');
  if (d.version !== input.expectedVersion) stale();
  if (d.state !== 'DRAFT') throw new HttpError(409, 'INVALID_STATE', 'Only a draft declaration can be changed');
  // The draft moves to the pack now active for its period, whose regimes and categories it is checked against.
  const pack = await activePack(tx, grant.companyId, d.fiscal_period_code, true);
  requireOpen(pack, grant.businessDate);
  const values = checkedValues(pack, input);
  await tx.query(`update tax_declaration set sealed_values = $3, line_count = $4, rule_pack_id = $5, updated_by = $6 where company_id = $1 and id = $2`, [
    grant.companyId,
    id,
    sealJson(values, declarationBinding(grant.companyId, employeeId, id)),
    values.lines.length,
    pack.id,
    grant.userId,
  ]);
  await audit(tx, actorOf(grant), 'tax_declaration', id, 'UPDATE', { operational: { state: 'DRAFT' } }, { operational: { state: 'DRAFT', rulePackId: pack.id, lineCount: values.lines.length } });
  return ownDeclarationView(tx, grant, employeeId, id);
}

export async function submitOwnDeclaration(tx: Queryable, grant: AccessGrant, id: string, input: { expectedVersion: number }) {
  const employeeId = ownEmployee(grant);
  const d = await lockOwnDeclaration(tx, grant, employeeId, id);
  await reassertOwn(tx, grant, 'submit');
  if (d.version !== input.expectedVersion) stale();
  if (d.state !== 'DRAFT') throw new HttpError(409, 'INVALID_STATE', 'Only a draft declaration can be submitted');
  const pack = await activePack(tx, grant.companyId, d.fiscal_period_code, true);
  if (pack.id !== d.rule_pack_id) throw new HttpError(409, 'TAX_RULE_PACK_CHANGED', 'A new rule pack replaced the one this draft was written under; save the draft again against it');
  requireOpen(pack, grant.businessDate);
  checkedValues(pack, openJson<SealedDeclaration>(d.sealed_values, declarationBinding(grant.companyId, employeeId, id)));
  const { taskId } = await startApproval(tx, { companyId: grant.companyId, kind: DECLARATION_KIND, transactionId: d.transaction_id, ownerEmployeeId: employeeId, actorUserId: grant.userId });
  await tx.query(`update business_transaction set state = 'SUBMITTED', updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, d.transaction_id, grant.userId]);
  await tx.query(`update tax_declaration set state = 'SUBMITTED', submitted_at = now(), updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, id, grant.userId]);
  await audit(tx, actorOf(grant), 'tax_declaration', id, 'SUBMIT', { operational: { state: 'DRAFT' } }, { operational: { state: 'SUBMITTED' } });
  await emit(tx, grant.companyId, 'tax_declaration.assigned', id, id, { declarationId: id, taskId });
  return ownDeclarationView(tx, grant, employeeId, id);
}

// ---------------------------------------------------------------------------------------------------------------
// TN09 the employee's own investment proofs
// ---------------------------------------------------------------------------------------------------------------

const PROOF_VIEW = `select f.id, f.employee_id as "employeeId", f.declaration_id as "declarationId", f.transaction_id as "transactionId", d.fiscal_period_code as "fiscalPeriodCode", f.category_code as "categoryCode",
    (select c.name from tax_rule_pack_category c where c.company_id = d.company_id and c.pack_id = d.rule_pack_id and c.code = f.category_code limit 1) as "categoryName",
    f.sealed_values as "sealedValues", f.sealed_decision as "sealedDecision", p.currency_code as "currencyCode", f.state, f.follows_proof_id as "followsProofId", f.decided_at as "decidedAt", f.employee_explanation as "employeeExplanation",
    f.created_at as "createdAt", f.version, e.employee_code as "employeeCode", e.display_name as "employeeName", ${EVIDENCE_JSON('f.company_id', 'f.transaction_id', '1')} as evidence
  from tax_proof f
  join tax_declaration d on d.company_id = f.company_id and d.id = f.declaration_id
  join tax_rule_pack p on p.company_id = d.company_id and p.id = d.rule_pack_id
  join employee e on e.company_id = f.company_id and e.id = f.employee_id`;

interface ProofView {
  id: string;
  employeeId: string;
  sealedValues: string;
  sealedDecision: string | null;
  [key: string]: unknown;
}

function openProof(companyId: string, f: ProofView) {
  const { sealedValues, sealedDecision, ...rest } = f;
  const values = openJson<SealedProof>(sealedValues, proofBinding(companyId, f.employeeId, f.id));
  const decision = sealedDecision ? openJson<SealedProofDecision>(sealedDecision, decisionBinding(companyId, f.employeeId, f.id)) : null;
  return { ...rest, claimedAmount: values.claimedAmount, acceptedAmount: decision?.acceptedAmount ?? null, rejectedAmount: decision?.rejectedAmount ?? null };
}

export async function ownProofs(db: Queryable, grant: AccessGrant, paging: Paging) {
  const employeeId = ownEmployee(grant);
  const page = await pageOf<ProofView>(db, `${PROOF_VIEW} where f.company_id = $1 and f.employee_id = $2`, [grant.companyId, employeeId], '"createdAt" desc, id', paging, LIST_CAP);
  return {
    ...page,
    items: page.items.map((f) => openProof(grant.companyId, f)),
    configuration: (await anyTaxRulePackActivated(db, grant.companyId)) ? { status: 'ACTIVE' as const } : { status: 'NOT_CONFIGURED' as const, code: 'TAX_RULE_PACK_NOT_CONFIGURED', message: NOT_CONFIGURED_MESSAGE },
    calculation: CALCULATION,
  };
}

export interface ProofInput {
  declarationId: string;
  categoryCode: string;
  claimedAmount: string;
  evidenceDocumentIds: string[];
  idempotencyKey: string;
  followsProofId?: string | undefined;
}

export async function submitOwnProof(tx: Queryable, grant: AccessGrant, input: ProofInput) {
  const employeeId = ownEmployee(grant);
  const key = optionalKey(input.idempotencyKey);
  await advisoryLock(tx, `tax_declaration:${grant.companyId}:${employeeId}`);
  await reassertOwn(tx, grant, 'submit');
  const replay = (await tx.query<{ id: string }>(`select id from tax_proof where company_id = $1 and employee_id = $2 and submit_key = $3`, [grant.companyId, employeeId, key])).rows[0];
  if (replay) return { ...(await ownProofView(tx, grant, employeeId, replay.id)), replayed: true };
  const d = (
    await tx.query<DeclarationRow>(`select ${DECLARATION_ROW} from tax_declaration where company_id = $1 and id = $2 and employee_id = $3 for share`, [grant.companyId, input.declarationId, employeeId])
  ).rows[0];
  // BR-055: someone else's declaration reads as missing.
  if (!d) throw notFound();
  if (d.state !== 'SUBMITTED' && d.state !== 'ACCEPTED') throw new HttpError(409, 'DECLARATION_NOT_SUBMITTED', 'A proof belongs to a submitted or accepted declaration');
  const pack = await activePack(tx, grant.companyId, d.fiscal_period_code, true);
  if (pack.id !== d.rule_pack_id) throw new HttpError(409, 'TAX_RULE_PACK_CHANGED', 'A new rule pack replaced the one your declaration was reviewed under');
  requireOpen(pack, grant.businessDate);
  const declared = openJson<SealedDeclaration>(d.sealed_values, declarationBinding(grant.companyId, employeeId, d.id));
  // H3 "declaration-linked categorized evidence".
  if (!declared.lines.some((l) => l.categoryCode === input.categoryCode)) throw new HttpError(422, 'CATEGORY_NOT_DECLARED', 'That category is not on your declaration', { field: 'categoryCode' });
  const claimedAmount = checkAmount(input.claimedAmount, pack.currencyMinorUnit, { field: 'claimedAmount' });
  if (input.evidenceDocumentIds.length === 0) throw new HttpError(422, 'EVIDENCE_REQUIRED', 'Attach at least one of your uploaded documents as evidence');
  const documents = await assertUsableEvidence(tx, grant.companyId, employeeId, input.evidenceDocumentIds);
  if (input.followsProofId) {
    const prior = (await tx.query<{ state: string; declaration_id: string }>(`select state, declaration_id from tax_proof where company_id = $1 and id = $2 and employee_id = $3`, [grant.companyId, input.followsProofId, employeeId])).rows[0];
    if (!prior) throw notFound();
    if (prior.declaration_id !== d.id || (prior.state !== 'RETURNED' && prior.state !== 'REJECTED')) throw new HttpError(409, 'INVALID_PREDECESSOR', 'A proof follows a returned or rejected proof of the same declaration');
  }
  const id = randomUUID();
  const transactionId = await newTransaction(tx, grant.companyId, PROOF_KIND, employeeId, 'SUBMITTED', grant.userId);
  await tx.query(
    `insert into tax_proof (id, company_id, employee_id, transaction_id, declaration_id, category_code, sealed_values, submit_key, state, follows_proof_id, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'SUBMITTED', $9, $10, $10)`,
    [id, grant.companyId, employeeId, transactionId, d.id, input.categoryCode, sealJson({ claimedAmount } satisfies SealedProof, proofBinding(grant.companyId, employeeId, id)), key, input.followsProofId ?? null, grant.userId],
  );
  await linkEvidence(tx, grant, transactionId, 1, employeeId, documents);
  const { taskId } = await startApproval(tx, { companyId: grant.companyId, kind: PROOF_KIND, transactionId, ownerEmployeeId: employeeId, actorUserId: grant.userId });
  await audit(tx, actorOf(grant), 'tax_proof', id, 'SUBMIT', null, { operational: { declarationId: d.id, categoryCode: input.categoryCode, evidenceDocuments: documents.length, state: 'SUBMITTED' } });
  await emit(tx, grant.companyId, 'tax_proof.assigned', id, id, { proofId: id, taskId });
  return { ...(await ownProofView(tx, grant, employeeId, id)), replayed: false };
}

async function ownProofView(db: Queryable, grant: AccessGrant, employeeId: string, id: string) {
  const f = (await db.query<ProofView>(`${PROOF_VIEW} where f.company_id = $1 and f.id = $2 and f.employee_id = $3`, [grant.companyId, id, employeeId])).rows[0];
  if (!f) throw notFound();
  return openProof(grant.companyId, f);
}

// ---------------------------------------------------------------------------------------------------------------
// Independent review (FR-036 "investment declaration checking"; ceiling-only `tax` grants of an eligible Admin)
// ---------------------------------------------------------------------------------------------------------------

/** Row scope and never the reviewer's own record, in SQL, so `total` counts only what the caller may see. */
function visible(grant: AccessGrant, params: SqlParams, company: string, employee: string): string[] {
  const where: string[] = [];
  if (!unrestricted(grant)) where.push(employeeScopePredicate(grant, { company, employee }, params));
  where.push(`not exists (select 1 from user_employee_link own where own.company_id = ${company} and own.employee_id = ${employee} and own.user_id = ${params.add(grant.userId)}::uuid)`);
  return where;
}

/** A draft is the employee's own until submitted (H3): reviewers see what was submitted. */
export async function listDeclarations(db: Queryable, grant: AccessGrant, q: { state?: string | undefined; employeeId?: string | undefined } & Paging) {
  const params = new SqlParams([grant.companyId]);
  const where = [`d.company_id = $1`, `d.state <> 'DRAFT'`, ...visible(grant, params, 'd.company_id', 'd.employee_id')];
  if (q.state) where.push(`d.state = ${params.add(q.state)}`);
  if (q.employeeId) where.push(`d.employee_id = ${params.add(q.employeeId)}::uuid`);
  const page = await pageOf<DeclarationView>(db, `${DECLARATION_VIEW} where ${where.join(' and ')}`, params.values, '"createdAt" desc, id', q, LIST_CAP);
  return { ...page, items: page.items.map((d) => openDeclaration(grant.companyId, d)), calculation: CALCULATION };
}

export async function listProofs(db: Queryable, grant: AccessGrant, q: { state?: string | undefined; employeeId?: string | undefined } & Paging) {
  const params = new SqlParams([grant.companyId]);
  const where = [`f.company_id = $1`, ...visible(grant, params, 'f.company_id', 'f.employee_id')];
  if (q.state) where.push(`f.state = ${params.add(q.state)}`);
  if (q.employeeId) where.push(`f.employee_id = ${params.add(q.employeeId)}::uuid`);
  const page = await pageOf<ProofView>(db, `${PROOF_VIEW} where ${where.join(' and ')}`, params.values, '"createdAt" desc, id', q, LIST_CAP);
  return { ...page, items: page.items.map((f) => openProof(grant.companyId, f)), calculation: CALCULATION };
}

export async function declarationTasks(db: Queryable, grant: AccessGrant) {
  const tasks = (await myOpenTasks(db, grant, DECLARATION_KIND)).items as { taskId: string; transactionId: string; assignedAt: Date }[];
  const items = [];
  for (const t of tasks) {
    const d = (await db.query<DeclarationView>(`${DECLARATION_VIEW} where d.company_id = $1 and d.transaction_id = $2`, [grant.companyId, t.transactionId])).rows[0];
    if (d) items.push({ taskId: t.taskId, assignedAt: t.assignedAt, declaration: openDeclaration(grant.companyId, d) });
  }
  return { items };
}

export async function proofTasks(db: Queryable, grant: AccessGrant) {
  const tasks = (await myOpenTasks(db, grant, PROOF_KIND)).items as { taskId: string; transactionId: string; assignedAt: Date }[];
  const items = [];
  for (const t of tasks) {
    const f = (await db.query<ProofView>(`${PROOF_VIEW} where f.company_id = $1 and f.transaction_id = $2`, [grant.companyId, t.transactionId])).rows[0];
    if (f) items.push({ taskId: t.taskId, assignedAt: t.assignedAt, proof: openProof(grant.companyId, f) });
  }
  return { items };
}

async function assertNotOwn(db: Queryable, grant: AccessGrant, employeeId: string): Promise<void> {
  assertNotSelf(grant, employeeId);
  if (await userIsEmployee(db, grant.companyId, grant.userId, employeeId)) throw new HttpError(403, 'SELF_ACTION_NOT_ALLOWED', 'You cannot review your own record');
}

export interface ReviewDecision {
  decision: 'ACCEPT' | 'REJECT' | 'RETURN';
  /** H4: shown to the employee; required for a return or a rejection. */
  explanation?: string | undefined;
  /** The reviewer's private reason: kept with the decision, never shown to the employee (H3). */
  reason?: string | undefined;
  idempotencyKey: string;
}

const ENGINE_DECISION = { ACCEPT: 'APPROVE', REJECT: 'REJECT', RETURN: 'RETURN' } as const;
const FINAL_STATE = { ACCEPT: 'ACCEPTED', REJECT: 'REJECTED', RETURN: 'RETURNED' } as const;

export async function decideDeclaration(tx: Queryable, grant: AccessGrant, taskId: string, input: ReviewDecision) {
  const t = await taskTransaction(tx, grant, taskId, [DECLARATION_KIND]);
  await lockTransaction(tx, t.transactionId);
  const d = (await tx.query<DeclarationRow>(`select ${DECLARATION_ROW} from tax_declaration where company_id = $1 and transaction_id = $2 for update`, [grant.companyId, t.transactionId])).rows[0];
  if (!d) throw notFound();
  await assertInScope(tx, grant, d.employee_id);
  if (await priorDecision(tx, grant.companyId, input.idempotencyKey, taskId)) return { declarationId: d.id, state: d.state, replayed: true };
  if (!(await taskIsPending(tx, grant, taskId))) throw new HttpError(409, 'TASK_CLOSED', 'This task has already been decided');
  if (d.state !== 'SUBMITTED') throw new HttpError(409, 'INVALID_STATE', 'This declaration is not waiting for a decision');
  await assertNotOwn(tx, grant, d.employee_id);
  let explanation: string | null = null;
  if (input.decision === 'ACCEPT') {
    // FR-108 "active tax-rule pack ... checked": a replaced pack leaves a declaration to return or reject, never to accept.
    const pack = await activePack(tx, grant.companyId, d.fiscal_period_code, true);
    if (pack.id !== d.rule_pack_id) throw new HttpError(409, 'TAX_RULE_PACK_CHANGED', 'A new rule pack replaced the one this declaration was written under; return it so the employee can correct it');
  } else {
    explanation = requireText(input.explanation, 'explanation', 1000, 'EXPLANATION_REQUIRED');
  }
  const result = await decideTask(tx, {
    grant,
    taskId,
    decision: ENGINE_DECISION[input.decision],
    // A return or rejection always records a reason: the private one, or else what the employee was told.
    reason: input.reason ?? explanation ?? undefined,
    idempotencyKey: input.idempotencyKey,
    permission: { resource: 'tax_declaration', action: 'review' },
  });
  if (result.replayed) return { declarationId: d.id, state: d.state, replayed: true };
  const state = FINAL_STATE[input.decision];
  await tx.query(`update business_transaction set state = $3, updated_by = $4 where company_id = $1 and id = $2`, [grant.companyId, d.transaction_id, state, grant.userId]);
  await tx.query(`update tax_declaration set state = $3, decided_at = now(), decided_by = $4, employee_explanation = $5, updated_by = $4 where company_id = $1 and id = $2`, [grant.companyId, d.id, state, grant.userId, explanation]);
  await audit(tx, actorOf(grant), 'tax_declaration', d.id, input.decision, { operational: { state: 'SUBMITTED' } }, { operational: { state } }, input.reason ?? null);
  await emit(tx, grant.companyId, 'tax_declaration.decided', d.id, `${d.id}:${state}`, { declarationId: d.id, outcome: state });
  return { declarationId: d.id, state, replayed: false };
}

export async function decideProof(tx: Queryable, grant: AccessGrant, taskId: string, input: ReviewDecision & { acceptedAmount?: string | undefined }) {
  const t = await taskTransaction(tx, grant, taskId, [PROOF_KIND]);
  await lockTransaction(tx, t.transactionId);
  const f = (
    await tx.query<{ id: string; employee_id: string; transaction_id: string; declaration_id: string; sealed_values: string; state: string }>(
      `select id, employee_id, transaction_id, declaration_id, sealed_values, state from tax_proof where company_id = $1 and transaction_id = $2 for update`,
      [grant.companyId, t.transactionId],
    )
  ).rows[0];
  if (!f) throw notFound();
  await assertInScope(tx, grant, f.employee_id);
  if (await priorDecision(tx, grant.companyId, input.idempotencyKey, taskId)) return { proofId: f.id, state: f.state, replayed: true };
  if (!(await taskIsPending(tx, grant, taskId))) throw new HttpError(409, 'TASK_CLOSED', 'This task has already been decided');
  if (f.state !== 'SUBMITTED') throw new HttpError(409, 'INVALID_STATE', 'This proof is not waiting for a decision');
  await assertNotOwn(tx, grant, f.employee_id);
  const claimed = openJson<SealedProof>(f.sealed_values, proofBinding(grant.companyId, f.employee_id, f.id)).claimedAmount;
  let decision: SealedProofDecision | null = null;
  let explanation: string | null = null;
  if (input.decision === 'ACCEPT') {
    const d = (await tx.query<{ state: string; rule_pack_id: string; fiscal_period_code: string }>(`select state, rule_pack_id, fiscal_period_code from tax_declaration where company_id = $1 and id = $2 for share`, [grant.companyId, f.declaration_id])).rows[0]!;
    if (d.state !== 'ACCEPTED') throw new HttpError(409, 'DECLARATION_NOT_ACCEPTED', 'A proof is accepted only against an accepted declaration');
    const pack = await activePack(tx, grant.companyId, d.fiscal_period_code, true);
    if (pack.id !== d.rule_pack_id) throw new HttpError(409, 'TAX_RULE_PACK_CHANGED', 'A new rule pack replaced the one this proof was declared under; return it');
    // H4; FR-106: every linked document released by the scan and verified by a reviewer.
    await requireVerifiedEvidence(tx, grant.companyId, f.employee_id, await revisionEvidence(tx, grant.companyId, f.transaction_id, 1), { required: true });
    if (input.acceptedAmount === undefined) throw new HttpError(422, 'ACCEPTED_AMOUNT_REQUIRED', 'State the accepted amount', { field: 'acceptedAmount' });
    const accepted = checkAmount(input.acceptedAmount, pack.currencyMinorUnit, { field: 'acceptedAmount' });
    // Exact decimals in PostgreSQL. H3 "accepted/rejected amount": the reviewer states what is accepted; the rest of the claim is rejected.
    const difference = (await tx.query<{ rest: string; within: boolean }>(`select ($1::numeric - $2::numeric)::text as rest, $2::numeric <= $1::numeric as within`, [claimed, accepted])).rows[0]!;
    if (!difference.within) throw new HttpError(422, 'ACCEPTED_ABOVE_CLAIM', 'The accepted amount cannot exceed the amount claimed', { field: 'acceptedAmount' });
    decision = { acceptedAmount: accepted, rejectedAmount: difference.rest };
  } else {
    if (input.acceptedAmount !== undefined) throw new HttpError(422, 'ACCEPTED_AMOUNT_NOT_ALLOWED', 'Only an acceptance states an accepted amount', { field: 'acceptedAmount' });
    explanation = requireText(input.explanation, 'explanation', 1000, 'EXPLANATION_REQUIRED');
    // A return decides no amount; a rejection rejects the whole claim. Neither creates an allowance (FR-108).
    if (input.decision === 'REJECT') decision = { acceptedAmount: '0', rejectedAmount: claimed };
  }
  const result = await decideTask(tx, {
    grant,
    taskId,
    decision: ENGINE_DECISION[input.decision],
    reason: input.reason ?? explanation ?? undefined,
    idempotencyKey: input.idempotencyKey,
    permission: { resource: 'tax_declaration', action: 'review' },
  });
  if (result.replayed) return { proofId: f.id, state: f.state, replayed: true };
  const state = FINAL_STATE[input.decision];
  await tx.query(`update business_transaction set state = $3, updated_by = $4 where company_id = $1 and id = $2`, [grant.companyId, f.transaction_id, state, grant.userId]);
  await tx.query(`update tax_proof set state = $3, decided_at = now(), decided_by = $4, employee_explanation = $5, sealed_decision = $6, updated_by = $4 where company_id = $1 and id = $2`, [
    grant.companyId,
    f.id,
    state,
    grant.userId,
    explanation,
    decision ? sealJson(decision, decisionBinding(grant.companyId, f.employee_id, f.id)) : null,
  ]);
  await audit(tx, actorOf(grant), 'tax_proof', f.id, input.decision, { operational: { state: 'SUBMITTED' } }, { operational: { state } }, input.reason ?? null);
  await emit(tx, grant.companyId, 'tax_proof.decided', f.id, `${f.id}:${state}`, { proofId: f.id, outcome: state });
  return { proofId: f.id, state, replayed: false };
}
