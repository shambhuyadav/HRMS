// Payroll inputs and salary stops (FR-031; DB039; DF05; H2; BR-050).
//
// Inputs. A batch (typed root payroll_input_batch) of lines, entered or uploaded (template PAYROLL_INPUTS_V1), each
// line with its period, employee, INPUT head, controlled input kind, amount in the calendar currency, effective date
// within the service period and a source reference. A reference is unique per company and period among live lines,
// a file is accepted once per period while its batch is live, and a request repeated with the same idempotency key
// returns the batch it created, so a repeated entry or upload never duplicates a payment. Uploads are scanned before
// they are read, all-or-nothing with row-level errors and a dry run (I-13). Lines are added before the period's input
// cutoff; the preparer submits the batch and an independent approver decides it (never the preparer, never anyone
// linked to an employee in the batch). Only APPROVED lines feed a calculation; once the calculation of an employee's
// run for the month has started (its snapshot is being taken), no further input for that employee is approved until
// the run is returned to a new draft; processing marks the included lines consumed. An approved line a processed run
// has not consumed can be reversed (DF03 controlled reversal), with a reason, by an approver independent of the
// preparer and the employee; while a live revision holds the employee's snapshot it must first be returned to a new
// draft. The reversal frees the reference, so a corrected line goes through entry and approval again.
//
// Salary stops. An instruction about one employee and period: HOLD_DISBURSEMENT (the DF05 default: the calculation
// continues and the payment is withheld; under H2/BR-050 it needs an active hold criterion) or EXCLUDE_CALCULATION
// (an explicitly approved exceptional mode: the employee is left out of the calculation, visibly; the approver
// confirms the mode). Proposed with a private reason and released, verified evidence documents, decided independently
// (never the maker or the employee), revocable before it is applied; processing applies it.
import { createHash } from 'node:crypto';
import { type Paging, pageOf } from '../../db/paging.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import type { ScanVerdict } from '../../storage/scan.js';
import { type AccessGrant, employeeScopePredicate, SqlParams } from '../access/authorize.js';
import { CsvError, parseCsv } from '../employee/csv.js';
import { cancelActiveApproval, decideTask, lockTransaction, myOpenTasks, startApproval } from '../workflow/engine.js';
import {
  actorOf,
  advisoryLock,
  assertInScope,
  assertNotSelf,
  attachEvidence,
  audit,
  checkAmount,
  emit,
  evidenceOf,
  isIsoDate,
  lockServiceMonth,
  newTransaction,
  optionalKey,
  outsideScope,
  priorDecision,
  requireActiveCriterion,
  requireFullScope,
  requireText,
  requireVerifiedEvidence,
  reviewersLackingScope,
  setRootState,
  taskDelegator,
  taskIsPending,
  taskTransaction,
  userIsEmployee,
  usersLinkedTo,
} from './common.js';
import { activePeriod, type PeriodRow, periodRow } from './config.js';
import { resolveExternalCodes } from './external-deductions.js';

export const INPUT_KIND = 'payroll_input_batch';
export const STOP_KIND = 'payroll_salary_stop';
export const UPLOAD_TEMPLATE = 'PAYROLL_INPUTS_V1';
/** The exact header an upload must carry (served as the published template, GET /payroll/input-batches/template). */
export const UPLOAD_HEADER: readonly string[] = ['employee_code', 'component_code', 'input_kind', 'amount', 'currency_code', 'effective_date', 'reference'];
/** I-13 batch bounds (10,000 rows / 10 MB). */
const MAX_ROWS = 10_000;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;

function stale(): never {
  throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');
}

/**
 * docs/09 §6.5 / I-25: input and stop actions that do not go through decideTask (entry, upload, submission,
 * cancellation, stop proposal, withdrawal and revocation) re-resolve their permission inside their own transaction
 * after their locks, so authority narrowed since the route guard refuses the action and records nothing.
 */
const reassertInput = (tx: Queryable, grant: AccessGrant) => reassertAccess(tx, grant, 'payroll_input', 'prepare', ['amount']);
const reassertStop = (tx: Queryable, grant: AccessGrant, action: 'propose' | 'decide') => reassertAccess(tx, grant, 'payroll_stop', action, ['hold']);

/**
 * Employees whose pay for the service month is being or has been taken from a snapshot: included members of a live
 * run of that month whose calculation has started (PROCESSED when the run is processed).
 */
async function snapshotTaken(db: Queryable, companyId: string, serviceMonth: string, employeeIds: readonly string[]): Promise<Map<string, 'PROCESSED' | 'IN_PROGRESS'>> {
  if (employeeIds.length === 0) return new Map();
  const rows = (
    await db.query<{ employee_id: string; state: string }>(
      `select m.employee_id, r.state from payroll_run_member m
         join payroll_run r on r.company_id = m.company_id and r.lineage_id = m.lineage_id
                           and r.state in ('DRAFT', 'CALCULATED', 'IN_REVIEW', 'APPROVED', 'PROCESSED_LOCKED')
        where m.company_id = $1 and m.service_month = $2::date and m.live and m.excluded_from_revision is null and m.employee_id = any($3::uuid[])
          and r.calculation_started_at is not null`,
      [companyId, serviceMonth, employeeIds],
    )
  ).rows;
  return new Map(rows.map((r) => [r.employee_id, r.state === 'PROCESSED_LOCKED' ? 'PROCESSED' : 'IN_PROGRESS']));
}

function requireBeforeCutoff(grant: AccessGrant, p: PeriodRow): void {
  if (grant.businessDate > p.input_cutoff) {
    throw new HttpError(409, 'INPUT_CUTOFF_PASSED', 'The input cutoff of this period has passed; enter the input for a later period', { inputCutoff: p.input_cutoff });
  }
}

export interface InputLine {
  employeeId?: string | undefined;
  employeeCode?: string | undefined;
  /** The pay component, or (I-91) blank when `externalCode` names an outside deduction code instead: exactly one of the two. */
  componentCode: string;
  externalCode?: string | undefined;
  inputKind: string;
  amount: string;
  currencyCode: string;
  effectiveDate: string;
  reference: string;
}

export interface CheckedLine {
  employeeId: string;
  componentId: string;
  /** I-91: the outside code the line named, kept on the input for reconciliation. */
  externalCode: string | null;
  kindId: string;
  amount: string;
  currencyCode: string;
  effectiveDate: string;
  reference: string;
}

/**
 * Validates lines set-based (a handful of statements whatever the row count). Errors are codes per row; a missing
 * and an out-of-scope employee get the same code.
 */
async function checkLines(tx: Queryable, grant: AccessGrant, p: PeriodRow, lines: InputLine[], firstRow: number): Promise<{ lines: CheckedLine[]; errors: { row: number; code: string }[] }> {
  const keyOf = (l: InputLine) => (l.employeeId ? `id:${l.employeeId}` : `code:${(l.employeeCode ?? '').trim().toUpperCase()}`);
  const ids = [...new Set(lines.flatMap((l) => (l.employeeId ? [l.employeeId] : [])))];
  const codes = [...new Set(lines.flatMap((l) => (l.employeeId ? [] : [(l.employeeCode ?? '').trim().toUpperCase()])))];
  const params = new SqlParams([grant.companyId, ids, codes, p.service_start, p.service_end]);
  const scope = employeeScopePredicate(grant, { company: 'e.company_id', employee: 'e.id' }, params);
  const employees = (
    await tx.query<{ id: string; employee_code: string; in_scope: boolean; employed: boolean }>(
      `select e.id, e.employee_code, ${scope} as in_scope,
              e.joining_date <= $5::date and coalesce(hrms_exit_last_working_date(e.company_id, e.id) >= $4::date, true) as employed
         from employee e where e.company_id = $1 and (e.id = any($2::uuid[]) or e.employee_code = any($3::text[]))`,
      params.values,
    )
  ).rows;
  const byKey = new Map<string, { id: string; in_scope: boolean; employed: boolean }>();
  for (const e of employees) {
    byKey.set(`id:${e.id}`, e);
    byKey.set(`code:${e.employee_code}`, e);
  }
  // I-91: an outside deduction code resolves to its component through the mapping in force on the line's effective date.
  const externalOf = (l: InputLine) => (l.externalCode ?? '').trim().toUpperCase();
  const resolved = await resolveExternalCodes(
    tx,
    grant.companyId,
    lines.filter((l) => externalOf(l) !== '').map((l) => ({ code: externalOf(l), date: l.effectiveDate.trim() })),
  );
  const componentOf = (l: InputLine): { code: string } | { error: string } => {
    const component = (l.componentCode ?? '').trim().toUpperCase();
    const external = externalOf(l);
    if ((component === '') === (external === '')) return { error: 'COMPONENT_OR_EXTERNAL_CODE' };
    if (component) return { code: component };
    const r = resolved.get(`${external}|${l.effectiveDate.trim()}`);
    return !r ? { error: 'EXTERNAL_CODE_UNKNOWN' } : 'error' in r ? { error: r.error } : { code: r.componentCode };
  };
  const heads = new Map(
    (
      await tx.query<{ code: string; id: string }>(
        `select c.code, c.id from pay_component c
          cross join lateral (select hr.in_use, hr.calculation_basis from payroll_head_revision hr
                               where hr.company_id = c.company_id and hr.component_id = c.id and hr.state = 'ACTIVE' and hr.effective_from <= $3::date
                               order by hr.effective_from desc limit 1) h
          where c.company_id = $1 and c.code = any($2::text[]) and c.active and h.in_use and h.calculation_basis = 'INPUT'`,
        [grant.companyId, [...new Set(lines.flatMap((l) => { const c = componentOf(l); return 'code' in c ? [c.code] : []; }))], p.service_end],
      )
    ).rows.map((r) => [r.code, r.id]),
  );
  const kinds = new Map(
    (
      await tx.query<{ code: string; id: string }>(`select code, id from reference_value where company_id = $1 and category = 'PAYROLL_INPUT_KIND' and code = any($2::text[]) and active`, [
        grant.companyId,
        [...new Set(lines.map((l) => l.inputKind.trim().toUpperCase()))],
      ])
    ).rows.map((r) => [r.code, r.id]),
  );
  const results: (CheckedLine | { error: string })[] = lines.map((line) => {
    const e = byKey.get(keyOf(line));
    if (!e || !e.in_scope) return { error: 'UNKNOWN_EMPLOYEE' };
    if (grant.linkedEmployeeId === e.id) return { error: 'SELF_NOT_ALLOWED' };
    if (!e.employed) return { error: 'NOT_EMPLOYED_IN_PERIOD' };
    const component = componentOf(line);
    if ('error' in component) return { error: component.error };
    const componentId = heads.get(component.code);
    if (!componentId) return { error: 'INPUT_HEAD_INVALID' };
    const kindId = kinds.get(line.inputKind.trim().toUpperCase());
    if (!kindId) return { error: 'UNKNOWN_INPUT_KIND' };
    let amount: string;
    try {
      amount = checkAmount(line.amount, p.currency_minor_unit);
    } catch {
      return { error: 'INVALID_AMOUNT' };
    }
    const currency = line.currencyCode.trim().toUpperCase();
    if (currency !== p.currency_code) return { error: 'CURRENCY_MISMATCH' };
    const effectiveDate = line.effectiveDate.trim();
    if (!isIsoDate(effectiveDate) || effectiveDate < p.service_start || effectiveDate > p.service_end) return { error: 'DATE_OUTSIDE_PERIOD' };
    const reference = line.reference.trim();
    if (!REFERENCE.test(reference)) return { error: 'INVALID_REFERENCE' };
    return { employeeId: e.id, componentId, externalCode: externalOf(line) || null, kindId, amount, currencyCode: currency, effectiveDate, reference };
  });
  // Duplicates: within the batch, and against live inputs of the period (a repeated upload).
  const refs = results.flatMap((r) => ('error' in r ? [] : [r.reference]));
  const existing = new Set(
    (
      await tx.query<{ reference: string }>(`select reference from payroll_input where company_id = $1 and period_id = $2 and reference = any($3::text[]) and state in ('DRAFT', 'SUBMITTED', 'APPROVED')`, [
        grant.companyId,
        p.id,
        refs,
      ])
    ).rows.map((r) => r.reference),
  );
  const taken = await snapshotTaken(tx, grant.companyId, p.service_start, [...new Set(results.flatMap((r) => ('error' in r ? [] : [r.employeeId])))]);
  const seen = new Set<string>();
  const errors: { row: number; code: string }[] = [];
  const checked: CheckedLine[] = [];
  results.forEach((r, i) => {
    const row = i + firstRow;
    if ('error' in r) errors.push({ row, code: r.error });
    else if (existing.has(r.reference) || seen.has(r.reference)) errors.push({ row, code: 'DUPLICATE_REFERENCE' });
    else if (taken.get(r.employeeId) === 'PROCESSED') errors.push({ row, code: 'PERIOD_PROCESSED' });
    else {
      seen.add(r.reference);
      checked.push(r);
    }
  });
  return { lines: checked, errors };
}

async function insertBatch(
  tx: Queryable,
  grant: AccessGrant,
  p: PeriodRow,
  source: 'ENTRY' | 'UPLOAD',
  lines: CheckedLine[],
  hashes: { request: string; file: string | null },
  key: string | null,
) {
  const transactionId = await newTransaction(tx, grant.companyId, INPUT_KIND, null, 'DRAFT', grant.userId);
  const id = (
    await tx.query<{ id: string }>(
      `insert into payroll_input_batch (company_id, calendar_id, period_id, transaction_id, source, file_hash, request_hash, idempotency_key, line_count, state,
                                        prepared_by, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'DRAFT', $10, $10, $10) returning id`,
      [grant.companyId, p.calendar_id, p.id, transactionId, source, hashes.file, hashes.request, key, lines.length, grant.userId],
    )
  ).rows[0]!.id;
  await tx.query(
    `insert into payroll_input (company_id, batch_id, period_id, employee_id, component_id, input_kind_id, amount, currency_code, effective_date, source, reference,
                                external_code, state, created_by, updated_by)
     select $1, $2, $3, l.employee_id, l.component_id, l.kind_id, l.amount, l.currency_code, l.effective_date, $4, l.reference, l.external_code, 'DRAFT', $5, $5
       from unnest($6::uuid[], $7::uuid[], $8::uuid[], $9::numeric[], $10::text[], $11::date[], $12::text[], $13::text[])
            as l (employee_id, component_id, kind_id, amount, currency_code, effective_date, reference, external_code)`,
    [
      grant.companyId,
      id,
      p.id,
      source,
      grant.userId,
      lines.map((l) => l.employeeId),
      lines.map((l) => l.componentId),
      lines.map((l) => l.kindId),
      lines.map((l) => l.amount),
      lines.map((l) => l.currencyCode),
      lines.map((l) => l.effectiveDate),
      lines.map((l) => l.reference),
      lines.map((l) => l.externalCode),
    ],
  );
  const total = (await tx.query<{ t: string }>(`select coalesce(sum(amount), 0) as t from payroll_input where company_id = $1 and batch_id = $2`, [grant.companyId, id])).rows[0]!.t;
  await audit(tx, actorOf(grant), 'payroll_input_batch', id, source === 'ENTRY' ? 'ENTER' : 'UPLOAD', null, {
    operational: { periodCode: p.period_code, source, lineCount: lines.length, fileHash: hashes.file },
    amount: { total, currencyCode: p.currency_code },
  });
  return id;
}

/** The batch a repeated request created (same key: same content and same preparer, otherwise a conflict). */
async function replayedBatch(tx: Queryable, grant: AccessGrant, key: string | null, requestHash: string): Promise<string | null> {
  if (!key) return null;
  const prior = (await tx.query<{ id: string; request_hash: string; prepared_by: string }>(`select id, request_hash, prepared_by from payroll_input_batch where company_id = $1 and idempotency_key = $2`, [grant.companyId, key]))
    .rows[0];
  if (!prior) return null;
  if (prior.request_hash !== requestHash || prior.prepared_by !== grant.userId) throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used for another request');
  return prior.id;
}

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/**
 * I-91 PAYROLL_INPUTS_V2 import (input-import.ts): the active period a file names by its code, opened for a group of rows: one period
 * of an active calendar with that code (UNKNOWN_PERIOD / PERIOD_AMBIGUOUS otherwise), before its cutoff, serialised with the service
 * month's calculation starts as an entry is, and the preparation grant re-checked.
 */
export async function openImportPeriod(tx: Queryable, grant: AccessGrant, periodCode: string): Promise<PeriodRow | { error: string }> {
  const ids = (
    await tx.query<{ id: string }>(
      `select p.id from payroll_period p join payroll_calendar c on c.company_id = p.company_id and c.id = p.calendar_id
        where p.company_id = $1 and p.period_code = $2 and c.state = 'ACTIVE'`,
      [grant.companyId, periodCode.trim().toUpperCase()],
    )
  ).rows;
  if (ids.length === 0) return { error: 'UNKNOWN_PERIOD' };
  if (ids.length > 1) return { error: 'PERIOD_AMBIGUOUS' };
  const p = await activePeriod(tx, grant.companyId, ids[0]!.id);
  await lockServiceMonth(tx, grant.companyId, p.service_start);
  await reassertInput(tx, grant);
  if (grant.businessDate > p.input_cutoff) return { error: 'INPUT_CUTOFF_PASSED' };
  return p;
}

/** One import row checked exactly as an entered line is (checkLines): the checked line, or its error code. */
export async function checkImportLine(tx: Queryable, grant: AccessGrant, p: PeriodRow, line: InputLine): Promise<CheckedLine | { error: string }> {
  const r = await checkLines(tx, grant, p, [line], 1);
  return r.errors[0] ? { error: r.errors[0].code } : r.lines[0]!;
}

/** The checked rows of one period, written as one UPLOAD batch (then submitted and approved as any other). */
export async function writeImportBatch(tx: Queryable, grant: AccessGrant, p: PeriodRow, lines: CheckedLine[], fileHash: string): Promise<string> {
  // An upload batch names its file (0043: file_hash = request_hash): here the file's part for this period.
  const hash = sha256(`${fileHash}:${p.id}`);
  return insertBatch(tx, grant, p, 'UPLOAD', lines, { request: hash, file: hash }, null);
}

export async function createEntryBatch(tx: Queryable, grant: AccessGrant, periodId: string, input: { lines: InputLine[]; idempotencyKey?: string | undefined }) {
  const p = await activePeriod(tx, grant.companyId, periodId);
  const key = optionalKey(input.idempotencyKey);
  // References of a period are claimed one batch at a time (the database index is the final guard), and entry is
  // serialised with the service month's calculation starts.
  await lockServiceMonth(tx, grant.companyId, p.service_start);
  await reassertInput(tx, grant);
  const requestHash = sha256(JSON.stringify({ periodId: p.id, lines: input.lines }));
  const replay = await replayedBatch(tx, grant, key, requestHash);
  if (replay) return { ...(await batchDetail(tx, grant, replay)), replayed: true };
  requireBeforeCutoff(grant, p);
  const checked = await checkLines(tx, grant, p, input.lines, 1);
  if (checked.errors.length > 0) throw new HttpError(422, 'INVALID_LINES', 'Some input lines are not valid; nothing was saved', { errors: checked.errors });
  const id = await insertBatch(tx, grant, p, 'ENTRY', checked.lines, { request: requestHash, file: null }, key);
  return { ...(await batchDetail(tx, grant, id)), replayed: false };
}

/**
 * FR-031 upload (template PAYROLL_INPUTS_V1): scanned first (a finding refuses the file, nothing is read), then
 * all-or-nothing with row errors; a dry run validates only. The same file again while its batch is live (or the same
 * idempotency key) returns that batch instead of a second one.
 */
export async function uploadBatch(
  tx: Queryable,
  grant: AccessGrant,
  verdict: ScanVerdict,
  periodId: string,
  input: { contentBase64: string; dryRun?: boolean | undefined; idempotencyKey?: string | undefined },
) {
  const p = await activePeriod(tx, grant.companyId, periodId);
  const key = optionalKey(input.idempotencyKey);
  const bytes = Buffer.from(input.contentBase64, 'base64');
  if (bytes.length === 0) throw new HttpError(422, 'EMPTY_FILE', 'The file is empty');
  if (bytes.length > MAX_UPLOAD_BYTES) throw new HttpError(422, 'FILE_TOO_LARGE', 'At most 10 MB per upload');
  const fileHash = sha256(bytes);
  await lockServiceMonth(tx, grant.companyId, p.service_start);
  await reassertInput(tx, grant);
  if (input.dryRun !== true) {
    const replay =
      (await replayedBatch(tx, grant, key, fileHash)) ??
      (
        await tx.query<{ id: string }>(`select id from payroll_input_batch where company_id = $1 and period_id = $2 and file_hash = $3 and state in ('DRAFT', 'SUBMITTED', 'APPROVED')`, [
          grant.companyId,
          p.id,
          fileHash,
        ])
      ).rows[0]?.id ??
      null;
    if (replay) {
      const b = await batchDetail(tx, grant, replay);
      return { template: UPLOAD_TEMPLATE, dryRun: false, total: b.lineCount, accepted: b.lineCount, rejected: 0, applied: false, replayed: true, batchId: replay, errors: [] };
    }
  }
  requireBeforeCutoff(grant, p);
  // FR-106: an upload is never read before the scanner has released it; the file itself is not stored. The route asked
  // the scanner (scanInMemory) before this transaction opened.
  if (verdict.verdict === 'INFECTED') throw new HttpError(422, 'UPLOAD_QUARANTINED', 'The malware scan flagged the file; it was not read');
  if (verdict.verdict !== 'CLEAN') throw new HttpError(503, 'SCAN_UNAVAILABLE', 'The file could not be scanned now; nothing was saved, try again later');
  let rows: string[][];
  try {
    rows = parseCsv(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (e) {
    if (e instanceof CsvError || e instanceof TypeError) throw new HttpError(422, 'INVALID_FILE', 'The file is not valid UTF-8 CSV');
    throw e;
  }
  const header = rows[0]?.map((h) => h.trim().toLowerCase());
  if (!header || header.join(',') !== UPLOAD_HEADER.join(',')) throw new HttpError(422, 'INVALID_TEMPLATE', `The file must use the ${UPLOAD_TEMPLATE} header`, { expected: UPLOAD_HEADER });
  const data = rows.slice(1);
  if (data.length === 0) throw new HttpError(422, 'EMPTY_FILE', 'The file has no lines');
  if (data.length > MAX_ROWS) throw new HttpError(422, 'TOO_MANY_ROWS', `At most ${MAX_ROWS} rows per upload`);
  const shapeErrors: { row: number; code: string }[] = [];
  const lines: InputLine[] = [];
  const lineRows: number[] = [];
  data.forEach((cells, i) => {
    if (cells.length !== UPLOAD_HEADER.length) {
      shapeErrors.push({ row: i + 2, code: 'WRONG_CELL_COUNT' });
      return;
    }
    const [employeeCode, componentCode, inputKind, amount, currencyCode, effectiveDate, reference] = cells as [string, string, string, string, string, string, string];
    lines.push({ employeeCode, componentCode, inputKind, amount, currencyCode, effectiveDate, reference });
    lineRows.push(i + 2);
  });
  const checked = await checkLines(tx, grant, p, lines, 0);
  const errors = [...shapeErrors, ...checked.errors.map((e) => ({ row: lineRows[e.row] ?? e.row, code: e.code }))].sort((a, b) => a.row - b.row);
  const failedRows = new Set(errors.map((e) => e.row));
  const valid = errors.length === 0;
  const applied = valid && input.dryRun !== true;
  let batchId: string | null = null;
  if (applied) batchId = await insertBatch(tx, grant, p, 'UPLOAD', checked.lines, { request: fileHash, file: fileHash }, key);
  else {
    await audit(tx, actorOf(grant), 'payroll_input_batch', p.id, input.dryRun ? 'UPLOAD_DRY_RUN' : 'UPLOAD_REJECTED', null, {
      operational: { periodCode: p.period_code, rows: data.length, rejected: valid ? 0 : data.length, fileHash },
    });
  }
  return {
    template: UPLOAD_TEMPLATE,
    dryRun: input.dryRun === true,
    total: data.length,
    accepted: valid ? data.length : 0,
    rejected: valid ? 0 : data.length,
    applied,
    replayed: false,
    batchId,
    // Valid rows of a refused file are BATCH_REJECTED, so accepted + rejected always equals the rows read.
    errors: valid ? [] : [...errors, ...lineRows.filter((r) => !failedRows.has(r)).map((row) => ({ row, code: 'BATCH_REJECTED' }))].sort((a, b) => a.row - b.row),
  };
}

interface BatchRow {
  id: string;
  transaction_id: string;
  period_id: string;
  state: string;
  prepared_by: string;
  version: number;
}

async function lockBatch(tx: Queryable, companyId: string, batchId: string): Promise<BatchRow> {
  const t = (await tx.query<{ transaction_id: string }>(`select transaction_id from payroll_input_batch where company_id = $1 and id = $2`, [companyId, batchId])).rows[0];
  if (!t) throw notFound();
  await lockTransaction(tx, t.transaction_id);
  return (
    await tx.query<BatchRow>(`select id, transaction_id, period_id, state, prepared_by, version from payroll_input_batch where company_id = $1 and id = $2 for update`, [companyId, batchId])
  ).rows[0]!;
}

async function batchEmployees(db: Queryable, companyId: string, batchId: string): Promise<string[]> {
  return (await db.query<{ employee_id: string }>(`select distinct employee_id from payroll_input where company_id = $1 and batch_id = $2`, [companyId, batchId])).rows.map((r) => r.employee_id);
}

async function setBatchState(tx: Queryable, companyId: string, b: BatchRow, state: string, userId: string, extra = '', extraValues: unknown[] = []) {
  // The batch first: a line follows the state of its batch (database guard).
  await setRootState(tx, 'payroll_input_batch', companyId, b, state, userId, extra, extraValues);
  await tx.query(`update payroll_input set state = $3, updated_by = $4 where company_id = $1 and batch_id = $2`, [companyId, b.id, state, userId]);
}

export async function submitBatch(tx: Queryable, grant: AccessGrant, batchId: string, input: { expectedVersion: number }) {
  const b = await lockBatch(tx, grant.companyId, batchId);
  await reassertInput(tx, grant);
  if (b.version !== input.expectedVersion) stale();
  if (b.prepared_by !== grant.userId) throw new HttpError(403, 'NOT_PREPARER', 'The preparer of a batch submits it');
  if (b.state !== 'DRAFT') throw new HttpError(409, 'INVALID_STATE', 'Only a draft batch can be submitted');
  const p = await activePeriod(tx, grant.companyId, b.period_id);
  requireBeforeCutoff(grant, p);
  const employees = await batchEmployees(tx, grant.companyId, batchId);
  await requireFullScope(tx, grant, employees);
  await setBatchState(tx, grant.companyId, b, 'SUBMITTED', grant.userId, ', submitted_at = now()');
  // Never the preparer, never anyone whose own input is in the batch, and (I-25: a batch has no owner employee for the
  // engine to check) only a listed approver whose assignment covers every employee of the batch.
  const { taskId } = await startApproval(tx, {
    companyId: grant.companyId,
    kind: INPUT_KIND,
    transactionId: b.transaction_id,
    ownerEmployeeId: null,
    actorUserId: grant.userId,
    excludeUserIds: [
      grant.userId,
      ...(await usersLinkedTo(tx, grant.companyId, employees)),
      ...(await reviewersLackingScope(tx, grant.companyId, INPUT_KIND, (g) => outsideScope(tx, g, employees))),
    ],
  });
  await audit(tx, actorOf(grant), 'payroll_input_batch', batchId, 'SUBMIT', { operational: { state: 'DRAFT' } }, { operational: { state: 'SUBMITTED' } });
  await emit(tx, grant.companyId, 'payroll_inputs.assigned', batchId, batchId, { batchId, taskId });
  return batchDetail(tx, grant, batchId);
}

export async function cancelBatch(tx: Queryable, grant: AccessGrant, batchId: string, input: { reason: string; expectedVersion: number }) {
  const b = await lockBatch(tx, grant.companyId, batchId);
  await reassertInput(tx, grant);
  if (b.version !== input.expectedVersion) stale();
  if (b.prepared_by !== grant.userId) throw new HttpError(403, 'NOT_PREPARER', 'The preparer of a batch cancels it');
  if (b.state !== 'DRAFT' && b.state !== 'SUBMITTED') throw new HttpError(409, 'INVALID_STATE', 'Only a draft or submitted batch can be cancelled');
  const reason = requireText(input.reason, 'reason', 1000);
  if (b.state === 'SUBMITTED') await cancelActiveApproval(tx, grant.companyId, b.transaction_id, grant.userId);
  await setBatchState(tx, grant.companyId, b, 'CANCELLED', grant.userId, ', closed_at = now()');
  await audit(tx, actorOf(grant), 'payroll_input_batch', batchId, 'CANCEL', { operational: { state: b.state } }, { operational: { state: 'CANCELLED' } }, reason);
  return batchDetail(tx, grant, batchId);
}

export async function decideBatch(tx: Queryable, grant: AccessGrant, taskId: string, input: { decision: 'APPROVE' | 'REJECT'; reason?: string | undefined; idempotencyKey: string }) {
  const t = await taskTransaction(tx, grant, taskId, [INPUT_KIND]);
  await lockTransaction(tx, t.transactionId);
  const b = (
    await tx.query<BatchRow>(`select id, transaction_id, period_id, state, prepared_by, version from payroll_input_batch where company_id = $1 and transaction_id = $2 for update`, [
      grant.companyId,
      t.transactionId,
    ])
  ).rows[0];
  if (!b) throw notFound();
  if (await priorDecision(tx, grant.companyId, input.idempotencyKey, taskId)) return { batchId: b.id, state: b.state, replayed: true };
  if (!(await taskIsPending(tx, grant, taskId))) throw new HttpError(409, 'TASK_CLOSED', 'This task has already been decided');
  if (b.state !== 'SUBMITTED') throw new HttpError(409, 'INVALID_STATE', 'This batch is not waiting for a decision');
  // I-57 item 7: a delegate decides in the delegator's name, so the delegator is held to the same rules as the decider.
  const actingFor = await taskDelegator(tx, grant.companyId, taskId);
  if (b.prepared_by === grant.userId || b.prepared_by === actingFor) throw new HttpError(403, 'NOT_INDEPENDENT', 'The preparer of a batch does not decide it');
  const employees = await batchEmployees(tx, grant.companyId, b.id);
  await requireFullScope(tx, grant, employees);
  // One statement whatever the batch size (up to 10,000 lines): is or was the decider (or the person decided for) linked to any of its employees?
  const self = await tx.query(`select 1 from user_employee_link where company_id = $1 and user_id = any($2::uuid[]) and employee_id = any($3::uuid[]) limit 1`, [
    grant.companyId,
    [grant.userId, ...(actingFor ? [actingFor] : [])],
    employees,
  ]);
  if ((self.rowCount ?? 0) > 0) throw new HttpError(403, 'SELF_ACTION_NOT_ALLOWED', 'The batch contains your own input; another approver decides it');
  if (input.decision === 'REJECT') requireText(input.reason, 'reason', 1000);
  else {
    const p = await activePeriod(tx, grant.companyId, b.period_id);
    // Serialised with calculation and processing starts of the service month's runs, every calendar (same lock).
    await lockServiceMonth(tx, grant.companyId, p.service_start);
    const taken = await snapshotTaken(tx, grant.companyId, p.service_start, employees);
    if ([...taken.values()].includes('PROCESSED')) {
      throw new HttpError(409, 'PERIOD_PROCESSED', 'The batch has inputs for employees whose payroll for the period is processed; reject it and enter them for a later period');
    }
    if (taken.size > 0) {
      throw new HttpError(409, 'RUN_IN_PROGRESS', 'The calculation of a run including these employees has started; return that run to a new draft revision first, or reject the batch', {
        employees: taken.size,
      });
    }
  }
  const result = await decideTask(tx, { grant, taskId, decision: input.decision, reason: input.reason, idempotencyKey: input.idempotencyKey, permission: { resource: 'payroll_input', action: 'approve' } });
  if (result.replayed) return { batchId: b.id, state: b.state, replayed: true };
  const state = input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  await setBatchState(tx, grant.companyId, b, state, grant.userId, ', decided_at = now(), decided_by = $4, closed_at = now()');
  await audit(tx, actorOf(grant), 'payroll_input_batch', b.id, input.decision, { operational: { state: 'SUBMITTED' } }, { operational: { state } }, input.reason ?? null);
  await emit(tx, grant.companyId, 'payroll_inputs.decided', b.id, `${b.id}:${state}`, { batchId: b.id, outcome: state });
  return { batchId: b.id, state, replayed: false };
}

/**
 * DF03 "Approved changes need a controlled reversal/cancellation action": approved lines of a batch, chosen by id, all
 * or none. The decision is this call (as for a salary stop's revocation): the caller holds the input approval duty and
 * is neither the batch's preparer nor the employee of a reversed line, and the batch itself stays APPROVED.
 */
export async function reverseInputs(tx: Queryable, grant: AccessGrant, batchId: string, input: { inputIds: string[]; reason: string; expectedVersion: number }) {
  const b = await lockBatch(tx, grant.companyId, batchId);
  // A decision outside decideTask: the approver's authority is resolved again after the batch's locks.
  await reassertAccess(tx, grant, 'payroll_input', 'approve', ['amount']);
  if (b.version !== input.expectedVersion) stale();
  if (b.state !== 'APPROVED') throw new HttpError(409, 'INVALID_STATE', 'Only lines of an approved batch are reversed; the preparer cancels a draft or submitted batch');
  if (b.prepared_by === grant.userId) throw new HttpError(403, 'NOT_INDEPENDENT', 'The preparer of a batch does not reverse its lines');
  const reason = requireText(input.reason, 'reason', 1000);
  const p = await periodRow(tx, grant.companyId, b.period_id);
  if (!p) throw notFound();
  // Serialised with the calculation and processing starts of the service month (every calendar), like an approval.
  await lockServiceMonth(tx, grant.companyId, p.service_start);
  const ids = [...new Set(input.inputIds)];
  const lines = (
    await tx.query<{ id: string; employee_id: string; state: string; consumed_record_id: string | null }>(
      `select id, employee_id, state, consumed_record_id from payroll_input where company_id = $1 and batch_id = $2 and id = any($3::uuid[]) for update`,
      [grant.companyId, batchId, ids],
    )
  ).rows;
  if (lines.length !== ids.length) throw new HttpError(422, 'NOT_A_LINE', 'Every reversed line must be a line of this batch');
  const employees = [...new Set(lines.map((l) => l.employee_id))];
  await requireFullScope(tx, grant, employees);
  const self = await tx.query(`select 1 from user_employee_link where company_id = $1 and user_id = $2 and employee_id = any($3::uuid[]) limit 1`, [grant.companyId, grant.userId, employees]);
  if ((self.rowCount ?? 0) > 0) throw new HttpError(403, 'SELF_ACTION_NOT_ALLOWED', 'A reversed line is your own input; another approver decides it');
  if (lines.some((l) => l.consumed_record_id !== null)) {
    throw new HttpError(409, 'INPUT_CONSUMED', 'A processed run has used this input; a correction is a linked adjustment in a later period');
  }
  if (lines.some((l) => l.state !== 'APPROVED')) throw new HttpError(409, 'INVALID_STATE', 'Only an approved line is reversed');
  // A snapshot must keep agreeing with the approved inputs: the revision holding it is returned to a new draft first
  // (H2). A processed month is no obstacle here: that run did not use this line (it is not consumed).
  const taken = await snapshotTaken(tx, grant.companyId, p.service_start, employees);
  const running = [...taken.values()].filter((s) => s === 'IN_PROGRESS').length;
  if (running > 0) {
    throw new HttpError(409, 'RUN_IN_PROGRESS', 'The calculation of a run including these employees has started; return that run to a new draft revision first', { employees: running });
  }
  await tx.query(`update payroll_input set state = 'REVERSED', reversed_at = now(), reversed_by = $3, reversal_reason = $4, updated_by = $3 where company_id = $1 and id = any($2::uuid[])`, [
    grant.companyId,
    ids,
    grant.userId,
    reason,
  ]);
  // The batch's version moves too, so an approver working from an older view reloads it.
  await tx.query(`update payroll_input_batch set updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, batchId, grant.userId]);
  const total = (await tx.query<{ t: string }>(`select coalesce(sum(amount), 0) as t from payroll_input where company_id = $1 and id = any($2::uuid[])`, [grant.companyId, ids])).rows[0]!.t;
  await audit(tx, actorOf(grant), 'payroll_input_batch', batchId, 'REVERSE_LINES', { operational: { state: 'APPROVED' } }, {
    operational: { periodCode: p.period_code, reversedLines: ids.length, inputIds: ids, employeeIds: employees },
    amount: { total, currencyCode: p.currency_code },
  }, reason);
  await emit(tx, grant.companyId, 'payroll_inputs.reversed', batchId, `${batchId}:${b.version}`, { batchId, lines: ids.length });
  return batchDetail(tx, grant, batchId);
}

const BATCH_VIEW = `select b.id, b.period_id as "periodId", p.period_code as "periodCode", b.source, b.file_hash as "fileHash", b.line_count as "lineCount", b.state,
    (select count(*)::int from payroll_input r where r.company_id = b.company_id and r.batch_id = b.id and r.state = 'REVERSED') as "reversedLines",
    b.prepared_by as "preparedBy", b.submitted_at as "submittedAt", b.decided_at as "decidedAt", b.decided_by as "decidedBy", b.created_at as "createdAt", b.version
  from payroll_input_batch b join payroll_period p on p.company_id = b.company_id and p.id = b.period_id`;

/**
 * A batch with its lines inside the caller's row scope, never the caller's own lines (as for records, stops and holds:
 * own payroll data reaches an employee only through issued outputs, H1); `scopeComplete` says whether that is every line.
 */
export async function batchDetail(db: Queryable, grant: AccessGrant, batchId: string) {
  const b = (await db.query<{ lineCount: number } & Record<string, unknown>>(`${BATCH_VIEW} where b.company_id = $1 and b.id = $2`, [grant.companyId, batchId])).rows[0];
  if (!b) throw notFound();
  const params = new SqlParams([grant.companyId, batchId, grant.linkedEmployeeId]);
  const scope = employeeScopePredicate(grant, { company: 'i.company_id', employee: 'i.employee_id' }, params);
  const lines = (
    await db.query(
      `select i.id, i.employee_id as "employeeId", e.employee_code as "employeeCode", c.code as "componentCode", k.code as "inputKind", i.amount,
              i.currency_code as "currencyCode", i.effective_date as "effectiveDate", i.reference, i.source, i.state, i.consumed_record_id as "consumedRecordId",
              i.reversed_at as "reversedAt", i.reversed_by as "reversedBy", i.reversal_reason as "reversalReason"
         from payroll_input i
         join employee e on e.company_id = i.company_id and e.id = i.employee_id
         join pay_component c on c.company_id = i.company_id and c.id = i.component_id
         join reference_value k on k.company_id = i.company_id and k.id = i.input_kind_id
        where i.company_id = $1 and i.batch_id = $2 and ${scope} and i.employee_id is distinct from $3::uuid
        order by i.reference`,
      params.values,
    )
  ).rows;
  const all = await batchEmployees(db, grant.companyId, batchId);
  const outside = await outsideScope(db, grant, all);
  if (all.length > 0 && outside === all.length) throw notFound();
  const ownLines = grant.linkedEmployeeId !== null && all.includes(grant.linkedEmployeeId);
  return { ...b, lines, scopeComplete: outside === 0 && !ownLines };
}

/** Lists answered without page/pageSize (each list's first answer before it could page). */
export const BATCH_LIST_CAP = 200;
export const STOP_LIST_CAP = 500;

/** Input batches, newest first: one page (FR-056), or the first 200 without page/pageSize; `total` counts every match. */
export async function listBatches(db: Queryable, grant: AccessGrant, q: { periodId?: string | undefined; state?: string | undefined } & Paging) {
  return pageOf(
    db,
    `${BATCH_VIEW} where b.company_id = $1 and ($2::uuid is null or b.period_id = $2) and ($3::text is null or b.state = $3)`,
    [grant.companyId, q.periodId ?? null, q.state ?? null],
    '"createdAt" desc, id',
    q,
    BATCH_LIST_CAP,
  );
}

export async function inputTasks(db: Queryable, grant: AccessGrant) {
  const tasks = (await myOpenTasks(db, grant, INPUT_KIND)).items as { taskId: string; transactionId: string }[];
  const items = [];
  for (const t of tasks) {
    const b = (await db.query(`${BATCH_VIEW} where b.company_id = $1 and b.transaction_id = $2`, [grant.companyId, t.transactionId])).rows[0];
    items.push({ taskId: t.taskId, batch: b ?? null });
  }
  return { items };
}

// ---------------------------------------------------------------------------------------------------------------
// Salary stops
// ---------------------------------------------------------------------------------------------------------------

export interface StopInput {
  employeeId: string;
  /** DF05: HOLD_DISBURSEMENT unless the exceptional EXCLUDE_CALCULATION is asked for. */
  mode?: 'HOLD_DISBURSEMENT' | 'EXCLUDE_CALCULATION' | undefined;
  criterionId?: string | undefined;
  reason: string;
  releaseCriterion?: string | undefined;
  evidenceReference: string;
  evidenceDocumentIds?: string[] | undefined;
  idempotencyKey?: string | undefined;
}

interface StopRow {
  id: string;
  transaction_id: string;
  employee_id: string;
  period_id: string;
  mode: 'HOLD_DISBURSEMENT' | 'EXCLUDE_CALCULATION';
  criterion_id: string | null;
  state: string;
  proposed_by: string;
  version: number;
}

const STOP_COLUMNS = `id, transaction_id, employee_id, period_id, mode, criterion_id, state, proposed_by, version`;

export async function proposeStop(tx: Queryable, grant: AccessGrant, periodId: string, input: StopInput) {
  const p = await activePeriod(tx, grant.companyId, periodId);
  await assertInScope(tx, grant, input.employeeId);
  assertNotSelf(grant, input.employeeId);
  const key = optionalKey(input.idempotencyKey);
  await advisoryLock(tx, `payroll_stop:${grant.companyId}:${p.id}:${input.employeeId}`);
  await reassertStop(tx, grant, 'propose');
  if (key) {
    const prior = (await tx.query<{ id: string; employee_id: string; period_id: string; proposed_by: string }>(`select id, employee_id, period_id, proposed_by from payroll_salary_stop where company_id = $1 and idempotency_key = $2`, [grant.companyId, key])).rows[0];
    if (prior) {
      if (prior.employee_id !== input.employeeId || prior.period_id !== p.id || prior.proposed_by !== grant.userId) throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used for another request');
      return { ...(await stopDetail(tx, grant, prior.id)), replayed: true };
    }
  }
  const mode = input.mode ?? 'HOLD_DISBURSEMENT';
  const reason = requireText(input.reason, 'reason', 1000);
  const evidence = requireText(input.evidenceReference, 'evidence reference', 500, 'EVIDENCE_REQUIRED');
  let criterionId: string | null = null;
  let releaseCriterion: string | null = null;
  if (mode === 'HOLD_DISBURSEMENT') {
    // H2/BR-050: withholding a payment needs an activated, validated hold criterion; none is active by default.
    const c = input.criterionId
      ? (await tx.query<{ id: string; state: string }>(`select id, state from payroll_hold_criterion where company_id = $1 and id = $2`, [grant.companyId, input.criterionId])).rows[0]
      : undefined;
    if (!c || c.state !== 'ACTIVE') {
      throw new HttpError(409, 'HOLD_CRITERION_NOT_ACTIVE', 'Withholding a payment needs an active, validated hold criterion (H2); none applies');
    }
    criterionId = c.id;
    releaseCriterion = requireText(input.releaseCriterion, 'release criterion', 1000, 'RELEASE_CRITERION_REQUIRED');
  } else if (input.criterionId || input.releaseCriterion) {
    throw new HttpError(422, 'NOT_A_HOLD', 'Excluding the calculation is not a payment hold; it takes no hold criterion');
  }
  const documents = await requireVerifiedEvidence(tx, grant.companyId, input.employeeId, input.evidenceDocumentIds, { required: true });
  if ((await snapshotTaken(tx, grant.companyId, p.service_start, [input.employeeId])).get(input.employeeId) === 'PROCESSED') {
    throw new HttpError(409, 'PERIOD_PROCESSED', 'The payroll of this employee for the period is processed; a hold of the processed record goes through a hold case');
  }
  const live = await tx.query(`select 1 from payroll_salary_stop where company_id = $1 and period_id = $2 and employee_id = $3 and state in ('SUBMITTED', 'APPROVED', 'APPLIED')`, [
    grant.companyId,
    p.id,
    input.employeeId,
  ]);
  if ((live.rowCount ?? 0) > 0) throw new HttpError(409, 'STOP_EXISTS', 'The employee already has a salary stop for this period');
  const transactionId = await newTransaction(tx, grant.companyId, STOP_KIND, input.employeeId, 'SUBMITTED', grant.userId);
  const id = (
    await tx.query<{ id: string }>(
      `insert into payroll_salary_stop (company_id, calendar_id, period_id, employee_id, transaction_id, mode, criterion_id, reason, release_criterion, evidence_reference,
                                        idempotency_key, state, proposed_by, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'SUBMITTED', $12, $12, $12) returning id`,
      [grant.companyId, p.calendar_id, p.id, input.employeeId, transactionId, mode, criterionId, reason, releaseCriterion, evidence, key, grant.userId],
    )
  ).rows[0]!.id;
  await attachEvidence(tx, grant, transactionId, 1, input.employeeId, documents);
  const { taskId } = await startApproval(tx, {
    companyId: grant.companyId,
    kind: STOP_KIND,
    transactionId,
    ownerEmployeeId: input.employeeId,
    actorUserId: grant.userId,
    excludeUserIds: [grant.userId],
  });
  await audit(tx, actorOf(grant), 'payroll_salary_stop', id, 'PROPOSE', null, {
    operational: { periodCode: p.period_code, employeeId: input.employeeId, mode, state: 'SUBMITTED', evidenceDocuments: documents.length },
  }, reason);
  await emit(tx, grant.companyId, 'payroll_salary_stop.assigned', id, id, { stopId: id, taskId });
  return { ...(await stopDetail(tx, grant, id)), replayed: false };
}

async function lockStop(tx: Queryable, companyId: string, stopId: string): Promise<StopRow> {
  const t = (await tx.query<{ transaction_id: string }>(`select transaction_id from payroll_salary_stop where company_id = $1 and id = $2`, [companyId, stopId])).rows[0];
  if (!t) throw notFound();
  await lockTransaction(tx, t.transaction_id);
  return (await tx.query<StopRow>(`select ${STOP_COLUMNS} from payroll_salary_stop where company_id = $1 and id = $2 for update`, [companyId, stopId])).rows[0]!;
}

/** A stop decision changes what a calculation takes: refused once the employee's run for the month has a snapshot. */
async function requireNoSnapshot(tx: Queryable, companyId: string, s: StopRow): Promise<void> {
  const p = await activePeriod(tx, companyId, s.period_id);
  await lockServiceMonth(tx, companyId, p.service_start);
  const taken = (await snapshotTaken(tx, companyId, p.service_start, [s.employee_id])).get(s.employee_id);
  if (taken === 'PROCESSED') throw new HttpError(409, 'PERIOD_PROCESSED', 'The payroll of this employee for the period is processed');
  if (taken) throw new HttpError(409, 'RUN_IN_PROGRESS', 'The calculation of a run including this employee has started; return that run to a new draft revision first');
}

export async function decideStop(
  tx: Queryable,
  grant: AccessGrant,
  taskId: string,
  input: { decision: 'APPROVE' | 'REJECT'; reason?: string | undefined; idempotencyKey: string; confirmMode?: string | undefined },
) {
  const t = await taskTransaction(tx, grant, taskId, [STOP_KIND]);
  await lockTransaction(tx, t.transactionId);
  const s = (await tx.query<StopRow>(`select ${STOP_COLUMNS} from payroll_salary_stop where company_id = $1 and transaction_id = $2 for update`, [grant.companyId, t.transactionId])).rows[0];
  if (!s) throw notFound();
  await assertInScope(tx, grant, s.employee_id);
  if (await priorDecision(tx, grant.companyId, input.idempotencyKey, taskId)) return { stopId: s.id, state: s.state, replayed: true };
  if (!(await taskIsPending(tx, grant, taskId))) throw new HttpError(409, 'TASK_CLOSED', 'This task has already been decided');
  if (s.state !== 'SUBMITTED') throw new HttpError(409, 'INVALID_STATE', 'This salary stop is not waiting for a decision');
  // I-57 item 7: a delegate decides in the delegator's name, so the delegator is held to the same rules as the decider.
  const actingFor = await taskDelegator(tx, grant.companyId, taskId);
  if (s.proposed_by === grant.userId || s.proposed_by === actingFor) throw new HttpError(403, 'NOT_INDEPENDENT', 'The maker of a salary stop does not decide it');
  assertNotSelf(grant, s.employee_id);
  if (actingFor && (await userIsEmployee(tx, grant.companyId, actingFor, s.employee_id))) throw new HttpError(403, 'SELF_ACTION_NOT_ALLOWED', 'You cannot act on your own record in this context');
  if (input.decision === 'REJECT') requireText(input.reason, 'reason', 1000);
  else {
    // DF05: the mode is approved explicitly (EXCLUDE_CALCULATION is an exceptional mode, never implied).
    if (input.confirmMode !== s.mode) throw new HttpError(422, 'MODE_NOT_CONFIRMED', 'Confirm the stop mode you approve', { mode: s.mode });
    // H2/BR-050: withholding needs a criterion that is active when the decision is taken, not only when proposed
    // (share-locked, so a concurrent retirement is ordered before or after this decision).
    if (s.mode === 'HOLD_DISBURSEMENT') await requireActiveCriterion(tx, grant.companyId, s.criterion_id);
    await requireNoSnapshot(tx, grant.companyId, s);
  }
  const result = await decideTask(tx, { grant, taskId, decision: input.decision, reason: input.reason, idempotencyKey: input.idempotencyKey, permission: { resource: 'payroll_stop', action: 'decide' } });
  if (result.replayed) return { stopId: s.id, state: s.state, replayed: true };
  const state = input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  if (state === 'APPROVED') await setRootState(tx, STOP_KIND, grant.companyId, s, state, grant.userId, ', decided_at = now(), decided_by = $4, approved_mode = $5', [s.mode]);
  else await setRootState(tx, STOP_KIND, grant.companyId, s, state, grant.userId, ', decided_at = now(), decided_by = $4, closed_at = now()');
  await audit(tx, actorOf(grant), 'payroll_salary_stop', s.id, input.decision, { operational: { state: 'SUBMITTED' } }, { operational: { state, mode: s.mode } }, input.reason ?? null);
  return { stopId: s.id, state, replayed: false };
}

export async function withdrawStop(tx: Queryable, grant: AccessGrant, stopId: string, input: { reason: string }) {
  const s = await lockStop(tx, grant.companyId, stopId);
  await assertInScope(tx, grant, s.employee_id);
  await reassertStop(tx, grant, 'propose');
  if (s.proposed_by !== grant.userId) throw new HttpError(403, 'NOT_MAKER', 'Only the maker withdraws a salary stop proposal');
  if (s.state !== 'SUBMITTED') throw new HttpError(409, 'INVALID_STATE', 'Only a proposal can be withdrawn');
  const reason = requireText(input.reason, 'reason', 1000);
  await cancelActiveApproval(tx, grant.companyId, s.transaction_id, grant.userId);
  await setRootState(tx, STOP_KIND, grant.companyId, s, 'WITHDRAWN', grant.userId, ', closed_at = now()');
  await audit(tx, actorOf(grant), 'payroll_salary_stop', s.id, 'WITHDRAW', { operational: { state: 'SUBMITTED' } }, { operational: { state: 'WITHDRAWN' } }, reason);
  return stopDetail(tx, grant, stopId);
}

/** An approved stop not yet applied is revoked by an independent decider, before any calculation took it. */
export async function revokeStop(tx: Queryable, grant: AccessGrant, stopId: string, input: { reason: string; expectedVersion: number }) {
  const s = await lockStop(tx, grant.companyId, stopId);
  await assertInScope(tx, grant, s.employee_id);
  // A decision outside decideTask: the decider's authority is resolved again after the stop's locks.
  await reassertStop(tx, grant, 'decide');
  assertNotSelf(grant, s.employee_id);
  if (await userIsEmployee(tx, grant.companyId, grant.userId, s.employee_id)) throw new HttpError(403, 'SELF_ACTION_NOT_ALLOWED', 'You cannot act on your own record in this context');
  if (s.version !== input.expectedVersion) stale();
  if (s.state !== 'APPROVED') throw new HttpError(409, 'INVALID_STATE', 'Only an approved stop that is not yet applied can be revoked');
  if (s.proposed_by === grant.userId) throw new HttpError(403, 'NOT_INDEPENDENT', 'The maker of a salary stop does not revoke it');
  const reason = requireText(input.reason, 'reason', 1000);
  await requireNoSnapshot(tx, grant.companyId, s);
  await setRootState(tx, STOP_KIND, grant.companyId, s, 'REVOKED', grant.userId, ', revoked_by = $4, revoke_reason = $5, closed_at = now()', [reason]);
  await audit(tx, actorOf(grant), 'payroll_salary_stop', s.id, 'REVOKE', { operational: { state: 'APPROVED' } }, { operational: { state: 'REVOKED' } }, reason);
  return stopDetail(tx, grant, stopId);
}

const STOP_VIEW = `select s.id, s.period_id as "periodId", p.period_code as "periodCode", s.employee_id as "employeeId", e.employee_code as "employeeCode",
    e.display_name as "employeeName", s.mode, s.approved_mode as "approvedMode", c.code as "criterionCode", s.reason, s.release_criterion as "releaseCriterion",
    s.evidence_reference as "evidenceReference", s.state, s.proposed_by as "proposedBy", s.decided_at as "decidedAt", s.decided_by as "decidedBy",
    s.applied_record_id as "appliedRecordId", s.transaction_id as "transactionId", s.created_at as "createdAt", s.version
  from payroll_salary_stop s
  join payroll_period p on p.company_id = s.company_id and p.id = s.period_id
  join employee e on e.company_id = s.company_id and e.id = s.employee_id
  left join payroll_hold_criterion c on c.company_id = s.company_id and c.id = s.criterion_id`;

export async function stopDetail(db: Queryable, grant: AccessGrant, stopId: string) {
  const s = (await db.query<{ employeeId: string; transactionId: string } & Record<string, unknown>>(`${STOP_VIEW} where s.company_id = $1 and s.id = $2`, [grant.companyId, stopId])).rows[0];
  if (!s) throw notFound();
  await assertInScope(db, grant, s.employeeId);
  assertNotSelf(grant, s.employeeId);
  const { transactionId, ...rest } = s;
  return { ...rest, evidence: await evidenceOf(db, grant.companyId, transactionId) };
}

/** Salary stops within row scope (never the caller's own), newest first: one page (FR-056), or the first 500; `total` counts all. */
export async function listStops(db: Queryable, grant: AccessGrant, q: { periodId?: string | undefined; state?: string | undefined } & Paging) {
  const params = new SqlParams([grant.companyId, q.periodId ?? null, q.state ?? null, grant.linkedEmployeeId]);
  const scope = employeeScopePredicate(grant, { company: 's.company_id', employee: 's.employee_id' }, params);
  const page = await pageOf(
    db,
    `${STOP_VIEW} where s.company_id = $1 and ($2::uuid is null or s.period_id = $2) and ($3::text is null or s.state = $3) and ${scope}
        and s.employee_id is distinct from $4::uuid`,
    params.values,
    '"createdAt" desc, id',
    q,
    STOP_LIST_CAP,
  );
  return { ...page, items: page.items.map(({ transactionId: _t, ...r }) => r) };
}

export async function stopTasks(db: Queryable, grant: AccessGrant) {
  const tasks = (await myOpenTasks(db, grant, STOP_KIND)).items as { taskId: string; transactionId: string }[];
  const items = [];
  for (const t of tasks) {
    const s = (await db.query<Record<string, unknown>>(`${STOP_VIEW} where s.company_id = $1 and s.transaction_id = $2`, [grant.companyId, t.transactionId])).rows[0];
    if (!s) {
      items.push({ taskId: t.taskId, stop: null });
      continue;
    }
    const { transactionId: _t, ...stop } = s;
    items.push({ taskId: t.taskId, stop });
  }
  return { items };
}
