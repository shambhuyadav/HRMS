// FR-031 salary stop upload (BRD Appendix A "Upload Stop Salary", CL-087; DF05; H2; BR-050; DF09; FR-106; I-13; I-21). Decided under
// owner delegation (docs/03 I-66 "payroll-6"; 6 Nov 2026): the CL-087 page itself was never inspected, so the upload is built on the
// shared import framework (preview, commit or cancel, the submitter's own batches, the malware-scan hold, the published template) and
// each row is exactly a salary stop proposed one at a time.
//
// Template SALARY_STOPS_V1: period_code, employee_code, mode, criterion_code, reason, release_criterion, evidence_reference,
// evidence_document_ids. Each row is the request POST /payroll/periods/:id/salary-stops makes, through the same service function
// (inputs.ts proposeStop) under the same payroll_stop.propose.hold grant, so a row passes exactly when that request would: the period of
// an active calendar, the employee within the caller's row scope and never the caller's own record, a mode (blank is the DF05 default,
// HOLD_DISBURSEMENT), for withholding an active hold criterion and a release criterion, for exclusion neither, a reason, an evidence
// reference and released, verified evidence documents of that employee (their ids, separated by semicolons), no live stop of the
// employee for the period, and a period not yet processed for them. The codes in a row are resolved first: the period by its code among
// active calendars, the employee by code, the criterion by code (its active revision; a code with none still reaches proposeStop, which
// refuses it as not active).
//
// A committed row is a SUBMITTED stop like any single proposal: it waits for its own independent decision (never the uploader, never the
// employee), stop by stop, and the decider confirms its mode; nothing is approved by the upload. All or nothing: one row with a problem
// rejects the whole file. The same upload repeated under its idempotency key is the same batch; the same file uploaded again under a new
// key is refused row by row (STOP_EXISTS), so a repeated upload never duplicates a stop (FR-031 acceptance). Import rows keep the period
// and employee codes only (the business key), never a reason, release criterion, evidence reference or document.
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../db/transaction.js';
import { HttpError, notFound } from '../../http/errors.js';
import { requireAccess } from '../../http/guard.js';
import type { FileStore } from '../../storage/files.js';
import type { ScanProvider } from '../../storage/scan.js';
import { MAX_BATCH_BYTES, parseTemplate, RowError, type Template } from '../imports/batch.js';
import { type BatchSpec, cancelBatch, commitBatch, jobView, submitBatch } from '../imports/jobs.js';
import { batchFollowUpRoutes } from '../imports/routes.js';
import { proposeStop, type StopInput } from './inputs.js';

const COLUMNS = ['period_code', 'employee_code', 'mode', 'criterion_code', 'reason', 'release_criterion', 'evidence_reference', 'evidence_document_ids'] as const;
type Column = (typeof COLUMNS)[number];
export const SALARY_STOPS_V1: Template<Column> = { code: 'SALARY_STOPS_V1', columns: COLUMNS };

const MODES: readonly string[] = ['HOLD_DISBURSEMENT', 'EXCLUDE_CALCULATION'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The single proposal's body schema: at most 10 distinct document ids (payroll/routes.ts `documents`). */
const MAX_DOCUMENTS = 10;

/** The cell `evidence_document_ids`: distinct document ids separated by semicolons, as the single proposal's array (blank is none). */
function documentIds(cell: string): string[] {
  const ids = cell
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (ids.length > MAX_DOCUMENTS || ids.some((id) => !UUID.test(id)) || new Set(ids.map((id) => id.toLowerCase())).size !== ids.length) {
    throw new RowError('INVALID_DOCUMENT_IDS');
  }
  return ids.map((id) => id.toLowerCase());
}

export const SALARY_STOP_SPEC: BatchSpec<Column> = {
  kind: 'payroll_salary_stops',
  template: SALARY_STOPS_V1,
  parse: (bytes) => parseTemplate(bytes, SALARY_STOPS_V1),
  keyOf: (row, n) => (row.period_code && row.employee_code ? `${row.period_code.toUpperCase()}/${row.employee_code.toUpperCase()}` : `ROW-${n}`),
  async apply(client, grant, row) {
    if (row.mode !== '' && !MODES.includes(row.mode)) throw new RowError('INVALID_MODE');
    const evidenceDocumentIds = documentIds(row.evidence_document_ids);
    // The period by its code among active calendars (as the PAYROLL_INPUTS_V2 upload names it).
    const periods = (
      await client.query<{ id: string }>(
        `select p.id from payroll_period p join payroll_calendar c on c.company_id = p.company_id and c.id = p.calendar_id
          where p.company_id = $1 and p.period_code = $2 and c.state = 'ACTIVE'`,
        [grant.companyId, row.period_code.toUpperCase()],
      )
    ).rows;
    if (periods.length === 0) throw new RowError('UNKNOWN_PERIOD');
    if (periods.length > 1) throw new RowError('PERIOD_AMBIGUOUS');
    // Employee codes are stored upper-case (0001 check constraint).
    const employee = (await client.query<{ id: string }>(`select id from employee where company_id = $1 and employee_code = $2`, [grant.companyId, row.employee_code.toUpperCase()])).rows[0];
    if (!employee) throw new RowError('UNKNOWN_EMPLOYEE');
    let criterionId: string | undefined;
    if (row.criterion_code !== '') {
      // The active revision of the code, else its latest one (which proposeStop refuses as not active, in the single proposal's words).
      const c = (
        await client.query<{ id: string }>(
          `select id from payroll_hold_criterion where company_id = $1 and code = $2 order by (state = 'ACTIVE') desc, revision desc limit 1`,
          [grant.companyId, row.criterion_code.toUpperCase()],
        )
      ).rows[0];
      if (!c) throw new RowError('UNKNOWN_CRITERION');
      criterionId = c.id;
    }
    const input: StopInput = {
      employeeId: employee.id,
      mode: row.mode === '' ? undefined : (row.mode as StopInput['mode']),
      criterionId,
      reason: row.reason,
      releaseCriterion: row.release_criterion === '' ? undefined : row.release_criterion,
      evidenceReference: row.evidence_reference,
      evidenceDocumentIds,
    };
    try {
      // Row scope (OUT_OF_SCOPE), never-self, the grant rechecked under the stop's lock, the mode and its criterion, the reason, the
      // evidence, a processed period, an existing stop, the insert as SUBMITTED, its own approval task, audit and notice: exactly the
      // single proposal.
      await proposeStop(client, grant, periods[0]!.id, input);
    } catch (err) {
      // The caller's own record is refused in the single proposal's words, not as out of scope; so is a grant withdrawn since the guard.
      if (err instanceof HttpError && (err.code === 'SELF_ACTION_NOT_ALLOWED' || err.code === 'FORBIDDEN')) throw new RowError(err.code);
      throw err;
    }
  },
};

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
export const SALARY_STOP_IMPORTS = '/payroll/salary-stop-imports';

export async function salaryStopImportRoutes(app: FastifyInstance, opts: { db: Database; files: FileStore; scanner: ScanProvider }): Promise<void> {
  const { db, files, scanner } = opts;
  // Every stop upload route needs what POST /payroll/periods/:id/salary-stops needs: payroll_stop.propose with the hold group (DF02).
  const propose = (request: Parameters<typeof requireAccess>[1], recordKey?: string) =>
    requireAccess(db, request, 'payroll_stop', 'propose', ['hold'], { requireAll: true, ...(recordKey ? { recordKey } : {}) });

  app.post(
    SALARY_STOP_IMPORTS,
    {
      bodyLimit: Math.ceil(MAX_BATCH_BYTES * 1.4),
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['fileName', 'contentBase64', 'idempotencyKey'],
          properties: {
            fileName: { type: 'string', minLength: 1, maxLength: 255, pattern: '^[^/\\\\<>:"|?*\\x00-\\x1f\\x7f]+$' },
            contentBase64: { type: 'string', minLength: 4 },
            idempotencyKey: { type: 'string', minLength: 8, maxLength: 200 },
          },
        },
      },
    },
    async (request, reply) => {
      const grant = await propose(request);
      const { status, view } = await submitBatch(db, files, scanner, grant, SALARY_STOP_SPEC, request.body as { fileName: string; contentBase64: string; idempotencyKey: string });
      reply.status(status);
      return view;
    },
  );

  app.get(`${SALARY_STOP_IMPORTS}/:id`, { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const view = await jobView(db, await propose(request, id), SALARY_STOP_SPEC.kind, id);
    if (!view) throw notFound();
    return view;
  });

  // The caller's own batches, the published template and resuming a batch held for the malware scan (imports/routes.ts).
  batchFollowUpRoutes(app, { db, files, scanner, path: SALARY_STOP_IMPORTS, spec: SALARY_STOP_SPEC, readGrant: (request) => propose(request), submitGrant: (request, id) => propose(request, id) });

  app.post(`${SALARY_STOP_IMPORTS}/:id/commit`, { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return commitBatch(db, files, await propose(request, id), SALARY_STOP_SPEC, id);
  });

  app.post(`${SALARY_STOP_IMPORTS}/:id/cancel`, { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return cancelBatch(db, await propose(request, id), SALARY_STOP_SPEC.kind, id);
  });
}
