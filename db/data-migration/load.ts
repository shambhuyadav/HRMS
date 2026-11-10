// Load: the validated extract into the target company through the existing import pipelines, in dependency order, as the operator
// named on the command line (DF09, FR-009, FR-025, FR-029, FR-034, FR-064; CI16). Nothing is written unless the caller passed
// --commit and confirmed the company, and nothing at all if validation (run again here, against the company) has a failure.
//   masters            organisation masters the extract has and the company lacks (the org master create path)
//   employees          EMPLOYEE_ONBOARDING_V1: every loaded employee as a draft with the joining placement
//   assignments-N      EMPLOYEE_UPDATE_V1: the N-th dated placement change of each employee with history
//   shifts             SHIFT_PLAN_V1
//   activation-0       activation of the active employees at the top of the reporting chain (declared no-manager reason)
//   managers-D, activation-D   EMPLOYEE_UPDATE_V1 reporting lines of depth D (their managers are active by now), then activation
//   salary             SALARY_MASTER_V1 (the arrangement in force at cut-over)
//   leave-opening      LEAVE_OPENING_V1
//   loans              LOAN_REQUESTS_V1 (REQUESTED: each waits for its independent decision in the system)
// Each stage is all or nothing: an import batch is (imports/jobs.ts), and the masters and activation stages run in one
// transaction. A stage's batch carries a deterministic idempotency key (migration, stage, file hash), so a re-run skips what
// is committed and never applies a batch twice; a batch that was rejected is retried under a new attempt key.
import { writeAudit } from '../../apps/api/src/audit/audit.js';
import type { Queryable } from '../../apps/api/src/db/queryable.js';
import { type Database, withTransaction } from '../../apps/api/src/db/transaction.js';
import { HttpError } from '../../apps/api/src/http/errors.js';
import type { AccessGrant } from '../../apps/api/src/modules/access/authorize.js';
import { activateEmployee } from '../../apps/api/src/modules/employee/changes.js';
import { EMPLOYEE_IMPORT_SPEC } from '../../apps/api/src/modules/employee/imports.js';
import { EMPLOYEE_UPDATE_SPEC } from '../../apps/api/src/modules/employee/update-import.js';
import { rowErrorCode } from '../../apps/api/src/modules/imports/batch.js';
import { type BatchSpec, commitBatch, submitBatch } from '../../apps/api/src/modules/imports/jobs.js';
import { SALARY_MASTER_SPEC } from '../../apps/api/src/modules/increment/salary-master.js';
import { LEAVE_OPENING_SPEC } from '../../apps/api/src/modules/leave/opening-import.js';
import { createOrgMaster } from '../../apps/api/src/modules/org/routes.js';
import { LOAN_REQUEST_SPEC } from '../../apps/api/src/modules/payroll-outputs/loan-import.js';
import { isModuleActive } from '../../apps/api/src/modules/registry.js';
import { SHIFT_PLAN_SPEC } from '../../apps/api/src/modules/shift/plan-import.js';
import type { FileStore } from '../../apps/api/src/storage/files.js';
import type { ScanProvider } from '../../apps/api/src/storage/scan.js';
import { type Analysis, analyse, type ExtractInput, openingReason, type PlannedEmployee, type SourceRef } from './analyse.js';
import { MASTER_KINDS, type MasterKind } from './model.js';
import { grantFor, type Operator, OperatorError, resolveOperator, STAGE_NEEDS, type StageNeed } from './operator.js';
import { jobKeyPrefix, likePrefix, migrationRecordKey, readOnly, readTargetFacts } from './target.js';
import { sha256, toCsv } from './values.js';

/** The words a load must be confirmed with: the target company's code, typed again (records are permanent). */
export const CONFIRM_HINT = 'pass --commit and --confirm <company code>: loaded records are permanent (they can only be deactivated later)';

export class LoadRefused extends Error {
  constructor(
    readonly code: 'NOT_CONFIRMED' | 'COMPANY_MISMATCH' | 'VALIDATION_FAILED' | 'OPERATOR' | 'MODULE_INACTIVE',
    message: string,
    readonly analysis: Analysis | null = null,
  ) {
    super(message);
  }
}

export type Stage =
  | { kind: 'masters'; name: 'masters'; template: string; items: { kind: MasterKind; code: string; name: string; ref: SourceRef }[] }
  | { kind: 'import'; name: string; template: string; need: StageNeed; spec: BatchSpec<string>; rows: Record<string, string>[]; refs: SourceRef[] }
  | { kind: 'activation'; name: string; template: string; depth: number; employees: PlannedEmployee[] };

export interface StageOutcome {
  stage: string;
  template: string;
  state: 'COMMITTED' | 'ALREADY_COMMITTED' | 'NOTHING_TO_DO' | 'REJECTED' | 'HELD';
  jobId: string | null;
  rows: number;
  accepted: number;
  errors: { row: number | null; key: string; code: string; source: SourceRef | null }[];
  detail?: string;
}

export interface LoadResult {
  ok: boolean;
  migrationId: string;
  companyCode: string;
  operator: string;
  stages: StageOutcome[];
  analysis: Analysis;
}

const blankUpdate = { displayName: '', workEmail: '', departmentCode: '', locationCode: '', designationCode: '', gradeCode: '', managerEmployeeCode: '' };

/** The load's stages in dependency order, with the exact rows each template file will hold. */
export function buildStages(a: Analysis, manifest: ExtractInput['manifest']): Stage[] {
  const p = a.plan;
  const stages: Stage[] = [];
  stages.push({ kind: 'masters', name: 'masters', template: 'org master create', items: MASTER_KINDS.flatMap((kind) => p.masters[kind].map((x) => ({ kind, ...x }))) });
  stages.push({
    kind: 'import',
    name: 'employees',
    template: EMPLOYEE_IMPORT_SPEC.template.code,
    need: 'employees',
    spec: EMPLOYEE_IMPORT_SPEC,
    rows: p.employees.map((e) => ({ employeeCode: e.code, displayName: e.displayName, workEmail: e.workEmail, joiningDate: e.joiningDate, employmentType: e.employmentType, ...e.joining })),
    refs: p.employees.map((e) => e.ref),
  });
  const rounds = Math.max(0, ...p.employees.map((e) => e.changes.length));
  for (let k = 0; k < rounds; k++) {
    const changed = p.employees.filter((e) => e.changes[k]);
    stages.push({
      kind: 'import',
      name: `assignments-${k + 1}`,
      template: EMPLOYEE_UPDATE_SPEC.template.code,
      need: 'employeeUpdates',
      spec: EMPLOYEE_UPDATE_SPEC,
      rows: changed.map((e) => {
        const { ref: _ref, effectiveFrom, ...placement } = e.changes[k]!;
        return { ...blankUpdate, employeeCode: e.code, effectiveFrom, ...placement };
      }),
      refs: changed.map((e) => e.changes[k]!.ref),
    });
  }
  const shifted = p.employees.filter((e) => e.shiftCode);
  stages.push({
    kind: 'import',
    name: 'shifts',
    template: SHIFT_PLAN_SPEC.template.code,
    need: 'shifts',
    spec: SHIFT_PLAN_SPEC,
    rows: shifted.map((e) => ({ employeeCode: e.code, shiftCode: e.shiftCode!, effectiveFrom: e.shiftFrom! })),
    refs: shifted.map((e) => e.ref),
  });
  const deepest = Math.max(0, ...p.employees.map((e) => e.depth));
  for (let d = 0; d <= deepest; d++) {
    if (d > 0) {
      const reporting = p.employees.filter((e) => e.depth === d && e.managerCode);
      stages.push({
        kind: 'import',
        name: `managers-${d}`,
        template: EMPLOYEE_UPDATE_SPEC.template.code,
        need: 'employeeUpdates',
        spec: EMPLOYEE_UPDATE_SPEC,
        rows: reporting.map((e) => ({ ...blankUpdate, employeeCode: e.code, effectiveFrom: e.managerFrom!, managerEmployeeCode: e.managerCode! })),
        refs: reporting.map((e) => e.ref),
      });
    }
    stages.push({ kind: 'activation', name: `activation-${d}`, template: 'employee activation', depth: d, employees: p.employees.filter((e) => e.depth === d && e.activate) });
  }
  stages.push({
    kind: 'import',
    name: 'salary',
    template: SALARY_MASTER_SPEC.template.code,
    need: 'salary',
    spec: SALARY_MASTER_SPEC,
    rows: p.salaries.map((s) => ({ employeeCode: s.employeeCode, effectiveFrom: s.effectiveFrom, annualCtc: s.annualCtc, monthlyGross: s.monthlyGross, currency: s.currency })),
    refs: p.salaries.map((s) => s.ref),
  });
  const reason = openingReason(manifest.migrationId, manifest.sourceSystem);
  stages.push({
    kind: 'import',
    name: 'leave-opening',
    template: LEAVE_OPENING_SPEC.template.code,
    need: 'leaveOpening',
    spec: LEAVE_OPENING_SPEC,
    rows: p.leaveOpenings.map((l) => ({ employeeCode: l.employeeCode, leaveType: l.leaveType, units: l.units, effectiveDate: l.effectiveDate, reason })),
    refs: p.leaveOpenings.map((l) => l.ref),
  });
  stages.push({
    kind: 'import',
    name: 'loans',
    template: LOAN_REQUEST_SPEC.template.code,
    need: 'loans',
    spec: LOAN_REQUEST_SPEC,
    rows: p.loans.map((l) => ({ employeeCode: l.employeeCode, loanKind: l.loanKind, currencyCode: l.currency, principal: l.amount, purpose: l.purpose })),
    refs: p.loans.map((l) => l.ref),
  });
  return stages;
}

const stageSize = (s: Stage) => (s.kind === 'masters' ? s.items.length : s.kind === 'import' ? s.rows.length : s.employees.length);

export interface LoadOptions {
  db: Database;
  files: FileStore;
  scanner: ScanProvider;
  extract: ExtractInput;
  companyCode: string;
  operator: string;
  commit: boolean;
  confirm?: string | undefined;
  log?: (line: string) => void;
}

export async function loadExtract(o: LoadOptions): Promise<LoadResult> {
  const manifest = o.extract.manifest;
  const company = o.companyCode.trim().toUpperCase();
  // Refused before anything is read or written.
  if (!o.commit || (o.confirm ?? '').trim().toUpperCase() !== company) throw new LoadRefused('NOT_CONFIRMED', `Nothing was loaded: ${CONFIRM_HINT}`);
  if (manifest.company && manifest.company.trim().toUpperCase() !== company) throw new LoadRefused('COMPANY_MISMATCH', `The manifest is for company ${manifest.company}, not ${company}`);
  const log = o.log ?? (() => undefined);

  const facts = await readOnly(o.db, (tx) => readTargetFacts(tx, company, manifest.migrationId));
  const analysis = analyse(o.extract, facts);
  if (analysis.failed) {
    const failed = analysis.checks.filter((c) => c.status === 'FAIL').map((c) => `${c.id} (${c.findings.filter((f) => f.severity === 'FAIL').length})`);
    throw new LoadRefused('VALIDATION_FAILED', `Nothing was loaded: validation failed for ${failed.join(', ')}; fix the extract or the manifest and validate again`, analysis);
  }
  const stages = buildStages(analysis, manifest);
  if (stages.some((s) => s.name === 'loans' && stageSize(s) > 0) && !isModuleActive('payroll-outputs')) {
    throw new LoadRefused('MODULE_INACTIVE', 'Nothing was loaded: the extract has loans but the payroll outputs module is not active', analysis);
  }
  let op: Operator;
  try {
    op = await resolveOperator(o.db, company, o.operator);
    // Every grant a stage with rows needs, before anything is written.
    const needed = new Set<StageNeed>(stages.filter((s) => stageSize(s) > 0).map((s) => (s.kind === 'masters' ? 'masters' : s.kind === 'activation' ? 'activation' : s.need)));
    for (const n of needed) await grantFor(o.db, op, STAGE_NEEDS[n]);
  } catch (err) {
    if (err instanceof OperatorError) throw new LoadRefused('OPERATOR', `Nothing was loaded: ${err.message}`, analysis);
    throw err;
  }

  const outcomes: StageOutcome[] = [];
  for (const stage of stages) {
    const outcome = stage.kind === 'masters' ? await mastersStage(o, op, analysis, stage) : stage.kind === 'activation' ? await activationStage(o, op, analysis, stage) : await importStage(o, op, analysis, stage);
    outcomes.push(outcome);
    log(`${stage.name}: ${outcome.state}${outcome.jobId ? ` (job ${outcome.jobId})` : ''}${outcome.detail ? ` - ${outcome.detail}` : ''}`);
    if (outcome.state === 'REJECTED' || outcome.state === 'HELD') return { ok: false, migrationId: manifest.migrationId, companyCode: company, operator: op.accountKey, stages: outcomes, analysis };
  }
  // A run that changed something is closed with one record of every stage; a repeat that found everything committed writes nothing.
  if (outcomes.some((s) => s.state === 'COMMITTED')) {
    await withTransaction(o.db, (tx) =>
      stageAudit(tx, op, op.assignments[0]!.id, analysis, 'LOAD_COMPLETED', { stages: outcomes.map((s) => ({ stage: s.stage, state: s.state, jobId: s.jobId, rows: s.rows })) }),
    );
  }
  return { ok: true, migrationId: manifest.migrationId, companyCode: company, operator: op.accountKey, stages: outcomes, analysis };
}

/** CI16 provenance: which migration, manifest and source files a stage came from, by whom, and its outcome (operational values only). */
async function stageAudit(tx: Queryable, op: Operator, assignmentId: string, a: Analysis, action: 'LOAD_STAGE' | 'LOAD_COMPLETED', detail: Record<string, unknown>) {
  await writeAudit(tx, {
    companyId: op.companyId,
    resource: 'data_migration',
    recordKey: migrationRecordKey(op.companyId, a.migrationId),
    actorUserId: op.userId,
    actingAssignmentId: assignmentId,
    action,
    after: { operational: { migrationId: a.migrationId, sourceSystem: a.sourceSystem, cutoverDate: a.cutoverDate, manifestSha256: a.manifestSha256, sources: a.sources, ...detail } },
  });
}

const sourceLines = (refs: SourceRef[]) => refs.map((r) => `${r.file}:${r.line}`);

async function mastersStage(o: LoadOptions, op: Operator, a: Analysis, stage: Extract<Stage, { kind: 'masters' }>): Promise<StageOutcome> {
  const base: StageOutcome = { stage: stage.name, template: stage.template, state: 'NOTHING_TO_DO', jobId: null, rows: stage.items.length, accepted: 0, errors: [] };
  if (stage.items.length === 0) return base;
  const grant = await grantFor(o.db, op, STAGE_NEEDS.masters);
  let current = '';
  try {
    const created = await withTransaction(o.db, async (tx) => {
      const made: typeof stage.items = [];
      for (const item of stage.items) {
        current = `${item.kind} ${item.code}`;
        const exists = await tx.query(`select 1 from ${item.kind} where company_id = $1 and code = $2`, [op.companyId, item.code]);
        if (exists.rowCount) continue;
        await createOrgMaster(tx, grant, item.kind, { code: item.code, name: item.name });
        made.push(item);
      }
      if (made.length) await stageAudit(tx, op, grant.assignmentId, a, 'LOAD_STAGE', { stage: stage.name, template: stage.template, created: made.map((m) => `${m.kind}:${m.code}`), sourceLines: sourceLines(made.map((m) => m.ref)) });
      return made;
    });
    return { ...base, state: created.length ? 'COMMITTED' : 'NOTHING_TO_DO', accepted: created.length, detail: `${created.length} created, ${stage.items.length - created.length} already in the company` };
  } catch (err) {
    const code = rowErrorCode(err);
    if (code) return { ...base, state: 'REJECTED', errors: [{ row: null, key: current, code, source: null }], detail: (err as Error).message };
    throw err;
  }
}

async function activationStage(o: LoadOptions, op: Operator, a: Analysis, stage: Extract<Stage, { kind: 'activation' }>): Promise<StageOutcome> {
  const base: StageOutcome = { stage: stage.name, template: stage.template, state: 'NOTHING_TO_DO', jobId: null, rows: stage.employees.length, accepted: 0, errors: [] };
  if (stage.employees.length === 0) return base;
  const grant: AccessGrant = await grantFor(o.db, op, STAGE_NEEDS.activation);
  const reason = o.extract.manifest.policies?.noManagerReason?.trim();
  let current: PlannedEmployee | null = null;
  try {
    const activated = await withTransaction(o.db, async (tx) => {
      const done: PlannedEmployee[] = [];
      for (const e of stage.employees) {
        current = e;
        const row = (
          await tx.query<{ id: string; version: number; status: string }>(
            `select e.id, e.version, st.code as status from employee e join reference_value st on st.company_id = e.company_id and st.id = e.status_id
              where e.company_id = $1 and e.employee_code = $2`,
            [op.companyId, e.code],
          )
        ).rows[0];
        if (!row) throw new HttpError(422, 'UNKNOWN_EMPLOYEE', `Employee ${e.code} is not in the company`);
        if (row.status !== 'DRAFT') continue; // activated by an earlier run
        await activateEmployee(tx, grant, row.id, { expectedVersion: row.version, noManagerReason: e.managerCode ? undefined : reason });
        done.push(e);
      }
      if (done.length) await stageAudit(tx, op, grant.assignmentId, a, 'LOAD_STAGE', { stage: stage.name, template: stage.template, activated: done.map((e) => e.code), sourceLines: sourceLines(done.map((e) => e.ref)) });
      return done;
    });
    return { ...base, state: activated.length ? 'COMMITTED' : 'ALREADY_COMMITTED', accepted: activated.length };
  } catch (err) {
    const e = current as PlannedEmployee | null;
    const code = rowErrorCode(err);
    if (code) {
      const details = err instanceof HttpError && err.details ? ` ${JSON.stringify(err.details)}` : '';
      return { ...base, state: 'REJECTED', errors: [{ row: null, key: e?.code ?? '', code, source: e?.ref ?? null }], detail: `${(err as Error).message}${details}` };
    }
    throw err;
  }
}

interface JobView {
  id: string;
  state: string;
  rowCount: number | null;
  acceptedCount: number;
  rows: { rowNumber: number; businessKey: string; state: string; errorCode: string | null }[];
}

async function importStage(o: LoadOptions, op: Operator, a: Analysis, stage: Extract<Stage, { kind: 'import' }>): Promise<StageOutcome> {
  const base: StageOutcome = { stage: stage.name, template: stage.template, state: 'NOTHING_TO_DO', jobId: null, rows: stage.rows.length, accepted: 0, errors: [] };
  if (stage.rows.length === 0) return base;
  const csv = toCsv(stage.spec.template.columns, stage.rows);
  const hash = sha256(csv);
  const key = `${jobKeyPrefix(a.migrationId)}${stage.name}:${hash.slice(0, 32)}`;
  const earlier = (
    await o.db.query<{ id: string; state: string; submitted_by: string; idempotency_key: string; accepted_count: number }>(
      `select id, state, submitted_by, idempotency_key, accepted_count from import_job
        where company_id = $1 and kind = $2 and (idempotency_key = $3 or idempotency_key like $4) order by created_at, id`,
      [op.companyId, stage.spec.kind, key, likePrefix(`${key}:a`)],
    )
  ).rows;
  const committed = earlier.find((j) => j.state === 'COMMITTED');
  if (committed) return { ...base, state: 'ALREADY_COMMITTED', jobId: committed.id, accepted: committed.accepted_count };
  // A batch of this run still open (previewed, or held for the malware scan) is resumed; one that was rejected is not reused.
  const open = earlier.find((j) => j.submitted_by === op.userId && (j.state === 'PREVIEWED' || j.state === 'UPLOADED'));
  const idempotencyKey = open?.idempotency_key ?? (earlier.length === 0 ? key : `${key}:a${earlier.length + 1}`);
  const grant = await grantFor(o.db, op, STAGE_NEEDS[stage.need]);
  const rowErrors = (view: JobView) =>
    view.rows.filter((r) => r.errorCode && r.errorCode !== 'BATCH_REJECTED').map((r) => ({ row: r.rowNumber, key: r.businessKey, code: r.errorCode!, source: stage.refs[r.rowNumber - 1] ?? null }));
  try {
    const submitted = await submitBatch(o.db, o.files, o.scanner, grant, stage.spec, {
      fileName: `${a.migrationId}-${stage.name}.csv`,
      contentBase64: Buffer.from(csv, 'utf-8').toString('base64'),
      idempotencyKey,
    });
    const view = submitted.view as unknown as JobView;
    if (view.state === 'UPLOADED') return { ...base, state: 'HELD', jobId: view.id, detail: 'the malware scanner gave no verdict yet; run the load again to resume this batch' };
    if (view.state === 'COMMITTED') return { ...base, state: 'ALREADY_COMMITTED', jobId: view.id, accepted: view.acceptedCount };
    if (view.state !== 'PREVIEWED') return { ...base, state: 'REJECTED', jobId: view.id, errors: rowErrors(view), detail: `the ${stage.template} preview rejected the batch` };
    const done = (await commitBatch(o.db, o.files, grant, stage.spec, view.id)) as unknown as JobView;
    if (done.state !== 'COMMITTED') return { ...base, state: 'REJECTED', jobId: view.id, errors: rowErrors(done), detail: `the ${stage.template} commit rejected the batch` };
    await withTransaction(o.db, (tx) =>
      stageAudit(tx, op, grant.assignmentId, a, 'LOAD_STAGE', { stage: stage.name, template: stage.template, jobId: view.id, idempotencyKey, fileSha256: hash, rows: stage.rows.length, sourceLines: sourceLines(stage.refs) }),
    );
    return { ...base, state: 'COMMITTED', jobId: view.id, accepted: done.acceptedCount };
  } catch (err) {
    if (err instanceof HttpError) return { ...base, state: 'REJECTED', errors: [{ row: null, key: '', code: err.code, source: null }], detail: err.message };
    throw err;
  }
}
