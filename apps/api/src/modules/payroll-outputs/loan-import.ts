// FR-034 loan and advance upload ("support loan/advance entry and upload"; H3 TN15; I-32; DF09; FR-106; I-13; I-21).
// Template LOAN_REQUESTS_V1: employeeCode,loanKind,currencyCode,principal,purpose. Each row is the request an eligible
// Admin enters for an employee, made through the service function of POST /payroll-outputs/employees/:id/loans
// (loans.ts enterLoanFor) under the same payroll_loan.request grant and loan field group, so a row passes exactly when
// that request would: the route's cell patterns (loan kind, currency code, money), the employee within the caller's row
// scope and never the caller's own record, a currency an active payroll calendar pays in, at most its minor unit of
// decimals, a purpose. There is no interest column: no approved interest rate is configured, so loans are interest-free
// (I-32). A committed row is a REQUESTED loan like any single request: it waits for the independent decision of an
// eligible Admin who is neither the uploader nor the beneficiary (POST /payroll-outputs/loans/:id/decision), loan by
// loan; nothing is approved by the upload. The batch is all-or-nothing and follows the shared import lifecycle
// (preview, commit or cancel, the submitter's own batches, the malware-scan hold, the published template). The import
// rows keep the employee code only (the business key), never the principal or the purpose.
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../db/transaction.js';
import { HttpError, notFound } from '../../http/errors.js';
import { requireAccess } from '../../http/guard.js';
import type { FileStore } from '../../storage/files.js';
import type { ScanProvider } from '../../storage/scan.js';
import { MAX_BATCH_BYTES, parseTemplate, RowError, type Template } from '../imports/batch.js';
import { type BatchSpec, cancelBatch, commitBatch, jobView, submitBatch } from '../imports/jobs.js';
import { batchFollowUpRoutes } from '../imports/routes.js';
import { enterLoanFor, type LoanRequestInput } from './loans.js';

const COLUMNS = ['employeeCode', 'loanKind', 'currencyCode', 'principal', 'purpose'] as const;
type Column = (typeof COLUMNS)[number];
export const LOAN_REQUEST_TEMPLATE: Template<Column> = { code: 'LOAN_REQUESTS_V1', columns: COLUMNS };

// The body schema of POST /payroll-outputs/employees/:id/loans (routes.ts loanRequestBody), cell by cell.
const LOAN_KINDS: readonly string[] = ['LOAN', 'ADVANCE'];
const CURRENCY = /^[A-Z]{3}$/;
const MONEY = /^\d{1,15}(\.\d{1,4})?$/;

export const LOAN_REQUEST_SPEC: BatchSpec<Column> = {
  kind: 'payroll_loan_request',
  template: LOAN_REQUEST_TEMPLATE,
  // An employee may have several requests, as several single requests may be entered (no repeat rule is added here).
  parse: (bytes) => parseTemplate(bytes, LOAN_REQUEST_TEMPLATE),
  keyOf: (row, n) => row.employeeCode.toUpperCase() || `ROW-${n}`,
  async apply(client, grant, row) {
    if (!LOAN_KINDS.includes(row.loanKind)) throw new RowError('INVALID_LOAN_KIND');
    if (!CURRENCY.test(row.currencyCode)) throw new RowError('INVALID_CURRENCY');
    if (!MONEY.test(row.principal)) throw new RowError('INVALID_AMOUNT');
    // Employee codes are stored upper-case (0001 check constraint).
    const employee = (await client.query<{ id: string }>(`select id from employee where company_id = $1 and employee_code = $2`, [grant.companyId, row.employeeCode.toUpperCase()])).rows[0];
    if (!employee) throw new RowError('UNKNOWN_EMPLOYEE');
    const input: LoanRequestInput = { loanKind: row.loanKind as LoanRequestInput['loanKind'], currencyCode: row.currencyCode, principal: row.principal, purpose: row.purpose };
    try {
      // Row scope (OUT_OF_SCOPE), the grant rechecked under the employee's lock, the currency and its minor unit, the
      // purpose, the insert as REQUESTED and its audit: exactly the single request.
      await enterLoanFor(client, grant, employee.id, input);
    } catch (err) {
      // The caller's own record is refused in the single request's words, not as out of scope.
      if (err instanceof HttpError && err.code === 'SELF_ACTION_NOT_ALLOWED') throw new RowError(err.code);
      throw err;
    }
  },
};

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const IMPORTS = '/payroll-outputs/loan-imports';

export async function loanImportRoutes(app: FastifyInstance, opts: { db: Database; files: FileStore; scanner: ScanProvider }): Promise<void> {
  const { db, files, scanner } = opts;
  // Every loan upload route needs what POST /payroll-outputs/employees/:id/loans needs: payroll_loan.request with the
  // confidential loan group (DF02).
  const enter = (request: Parameters<typeof requireAccess>[1], recordKey?: string) =>
    requireAccess(db, request, 'payroll_loan', 'request', ['loan'], { requireAll: true, ...(recordKey ? { recordKey } : {}) });

  app.post(
    IMPORTS,
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
      const grant = await enter(request);
      const { status, view } = await submitBatch(db, files, scanner, grant, LOAN_REQUEST_SPEC, request.body as { fileName: string; contentBase64: string; idempotencyKey: string });
      reply.status(status);
      return view;
    },
  );

  app.get(`${IMPORTS}/:id`, { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const view = await jobView(db, await enter(request, id), LOAN_REQUEST_SPEC.kind, id);
    if (!view) throw notFound();
    return view;
  });

  // The caller's own batches, the published template and resuming a batch held for the malware scan (imports/routes.ts).
  batchFollowUpRoutes(app, { db, files, scanner, path: IMPORTS, spec: LOAN_REQUEST_SPEC, readGrant: (request) => enter(request), submitGrant: (request, id) => enter(request, id) });

  app.post(`${IMPORTS}/:id/commit`, { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return commitBatch(db, files, await enter(request, id), LOAN_REQUEST_SPEC, id);
  });

  app.post(`${IMPORTS}/:id/cancel`, { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return cancelBatch(db, await enter(request, id), LOAN_REQUEST_SPEC.kind, id);
  });
}
