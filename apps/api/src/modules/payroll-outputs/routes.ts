// Payroll outputs, bank files, issued payslips, reports and statutory outputs (FR-038, FR-039, FR-102, FR-107; H2;
// H3 TN06; H5): HTTP routes. Every handler calls requireAccess first. Template configuration is operational; the
// manifest, ledger, payslip and report routes need the confidential grants of an eligible Admin assignment (DF02);
// the restricted file needs the bank group. Row scope, independence and the re-check of authority after the locks
// (docs/09 §6.5) are in the services. The Employee OWN context reads only its own issued payslips.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { optionalPaging, type Paging } from '../../db/paging.js';
import { type Database, withTransaction } from '../../db/transaction.js';
import { requireAccess } from '../../http/guard.js';
import { downloadHeaders, type FileStore } from '../../storage/files.js';
import type { ScanProvider } from '../../storage/scan.js';
import {
  activateTemplate,
  authorizeManifest,
  batchDetail,
  batchLines,
  cancelManifest,
  createTemplate,
  issueManifest,
  listBatches,
  listTemplates,
  manifestFile,
  type OutcomeInput,
  type PrepareInput,
  prepareManifest,
  previewManifest,
  recordOutcomes,
  recordPayment,
  retireTemplate,
  reverseLine,
  type TemplateInput,
  templateDetail,
  templateSample,
  validateSample,
} from './bank.js';
import { loanImportRoutes } from './loan-import.js';
import {
  cancelLoan,
  decideLoan,
  type DecisionInput,
  type DisbursementInput,
  disburseLoan,
  type LoanRequestInput,
  listLoans,
  loanDetail,
  ownLoans,
  recognizeRecoveries,
  requestLoanFor,
  requestOwnLoan,
  withdrawOwnLoan,
} from './loans.js';
import { listRunOutputs, outputFile, ownHoldStatus, ownHoldStatusDetail, ownPayslipFile, ownPayslips, previewPayslip, publishRunPayslips, reissuePayslip } from './payslips.js';
import { comparisonReport, disbursementReport, journalVoucher, payrollRegister, statutoryOutput, statutoryOutputs } from './reports.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const reason = { type: 'string', minLength: 1, maxLength: 1000 } as const;
const reference = { type: 'string', minLength: 1, maxLength: 500 } as const;
const expectedVersion = { type: 'integer', minimum: 1 } as const;
const eventKey = { type: 'string', minLength: 8, maxLength: 100, pattern: '^[A-Za-z0-9._:-]+$' } as const;
const money = { type: 'string', pattern: '^\\d{1,15}(\\.\\d{1,4})?$' } as const;
const versionBody = { type: 'object', additionalProperties: false, required: ['expectedVersion'], properties: { expectedVersion } } as const;
const reasonVersionBody = { type: 'object', additionalProperties: false, required: ['reason', 'expectedVersion'], properties: { reason, expectedVersion } } as const;

const send = (reply: FastifyReply, file: { fileName: string; mediaType: string; bytes: Buffer }, fallback: string) => {
  reply.headers(downloadHeaders({ mediaType: file.mediaType, fileName: file.fileName }, fallback));
  return reply.send(file.bytes);
};

export async function payrollOutputsRoutes(app: FastifyInstance, opts: { db: Database; files: FileStore; scanner: ScanProvider }): Promise<void> {
  const { db, files, scanner } = opts;
  type Req = Parameters<typeof requireAccess>[1];
  const template = (request: Req, action: 'read' | 'manage' | 'validate' | 'activate', recordKey?: string) =>
    requireAccess(db, request, 'payroll_bank_template', action, ['operational'], { requireAll: true, ...(recordKey ? { recordKey } : {}) });
  const bank = (request: Req, action: 'read' | 'prepare' | 'authorize' | 'record_outcome', recordKey?: string) =>
    requireAccess(db, request, 'payroll_bank', action, ['amount'], { requireAll: true, ...(recordKey ? { recordKey } : {}) });
  const bankFile = (request: Req, recordKey: string) => requireAccess(db, request, 'payroll_bank', 'download', ['bank'], { requireAll: true, recordKey });
  const output = (request: Req, action: 'read' | 'publish', recordKey?: string) =>
    requireAccess(db, request, 'payroll_output', action, ['amount'], { requireAll: true, ...(recordKey ? { recordKey } : {}) });
  const report = (request: Req, recordKey: string) => requireAccess(db, request, 'payroll_report', 'read', ['amount'], { requireAll: true, recordKey });

  // ---------------------------------------------------------------------------------------------------------------
  // DB112 bank file templates (company configuration; no format presumed)
  // ---------------------------------------------------------------------------------------------------------------
  app.get('/payroll-outputs/bank-templates', async (request) => listTemplates(db, await template(request, 'read')));

  app.post(
    '/payroll-outputs/bank-templates',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['templateCode', 'name', 'currencyCode', 'bankSpecificationReference', 'testOnly', 'formatDefinition'],
          properties: {
            templateCode: { type: 'string', minLength: 2, maxLength: 40 },
            name: { type: 'string', minLength: 1, maxLength: 200 },
            currencyCode: { type: 'string', pattern: '^[A-Z]{3}$' },
            bankSpecificationReference: reference,
            testOnly: { type: 'boolean' },
            formatDefinition: { type: 'object' },
          },
        },
      },
    },
    async (request, reply) => {
      const grant = await template(request, 'manage');
      const result = await withTransaction(db, (tx) => createTemplate(tx, grant, request.body as TemplateInput));
      reply.status(201);
      return result;
    },
  );

  app.get('/payroll-outputs/bank-templates/:id', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return templateDetail(db, await template(request, 'read', id), id);
  });

  app.get('/payroll-outputs/bank-templates/:id/sample', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return templateSample(db, await template(request, 'read', id), id);
  });

  app.post(
    '/payroll-outputs/bank-templates/:id/sample-validation',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['sampleHash', 'validationReference', 'expectedVersion'],
          properties: { sampleHash: { type: 'string', pattern: '^[0-9a-f]{64}$' }, validationReference: reference, expectedVersion },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await template(request, 'validate', id);
      return withTransaction(db, (tx) => validateSample(tx, grant, id, request.body as { sampleHash: string; validationReference: string; expectedVersion: number }));
    },
  );

  app.post('/payroll-outputs/bank-templates/:id/activate', { schema: { params: idParams, body: versionBody } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await template(request, 'activate', id);
    return withTransaction(db, (tx) => activateTemplate(tx, grant, id, request.body as { expectedVersion: number }));
  });

  app.post('/payroll-outputs/bank-templates/:id/retire', { schema: { params: idParams, body: reasonVersionBody } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await template(request, 'manage', id);
    return withTransaction(db, (tx) => retireTemplate(tx, grant, id, request.body as { reason: string; expectedVersion: number }));
  });

  // ---------------------------------------------------------------------------------------------------------------
  // FR-102 manifests, file and outcomes. A manifest covers the whole run in one transaction, and a request may carry up
  // to 1,000 outcomes, so these routes declare the batch serving class (docs/09 §8.2).
  // ---------------------------------------------------------------------------------------------------------------
  const runWide = { servingClass: 'batch' } as const;
  app.get(
    '/payroll-outputs/runs/:id/bank-preview',
    { config: runWide, schema: { params: idParams, querystring: { type: 'object', additionalProperties: false, properties: { templateId: uuid } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      return previewManifest(db, await bank(request, 'read', id), id, request.query as { templateId?: string });
    },
  );

  app.get('/payroll-outputs/runs/:id/bank-manifests', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return listBatches(db, await bank(request, 'read', id), id);
  });

  app.post(
    '/payroll-outputs/runs/:id/bank-manifests',
    {
      config: runWide,
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['templateId'],
          properties: {
            templateId: uuid,
            excludeEmployeeIds: { type: 'array', maxItems: 1000, uniqueItems: true, items: uuid },
            exclusionReason: reason,
            supersedesBatchId: uuid,
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const grant = await bank(request, 'prepare', id);
      const result = await withTransaction(db, (tx) => prepareManifest(tx, grant, id, request.body as PrepareInput));
      reply.status(201);
      return result;
    },
  );

  app.get('/payroll-outputs/bank-manifests/:id', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return batchDetail(db, await bank(request, 'read', id), id);
  });

  app.get(
    '/payroll-outputs/bank-manifests/:id/lines',
    { schema: { params: idParams, querystring: { type: 'object', additionalProperties: false, properties: { after: { type: 'integer', minimum: 0 } } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      return batchLines(db, await bank(request, 'read', id), id, request.query as { after?: number });
    },
  );

  app.post('/payroll-outputs/bank-manifests/:id/authorize', { config: runWide, schema: { params: idParams, body: versionBody } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await bank(request, 'authorize', id);
    return withTransaction(db, (tx) => authorizeManifest(tx, grant, id, request.body as { expectedVersion: number }));
  });

  app.post('/payroll-outputs/bank-manifests/:id/cancel', { schema: { params: idParams, body: reasonVersionBody } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await bank(request, 'prepare', id);
    return withTransaction(db, (tx) => cancelManifest(tx, grant, id, request.body as { reason: string; expectedVersion: number }));
  });

  app.post('/payroll-outputs/bank-manifests/:id/issue', { config: runWide, schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await bankFile(request, id);
    return withTransaction(db, (tx) => issueManifest(tx, files, grant, id));
  });

  app.get('/payroll-outputs/bank-manifests/:id/file', { schema: { params: idParams } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const grant = await bankFile(request, id);
    const file = await withTransaction(db, (tx) => manifestFile(tx, files, grant, id));
    return send(reply, file, 'bank-file.txt');
  });

  app.post(
    '/payroll-outputs/bank-manifests/:id/outcomes',
    {
      config: runWide,
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['outcomes'],
          properties: {
            outcomes: {
              type: 'array',
              minItems: 1,
              maxItems: 1000,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['lineId', 'outcome', 'eventKey', 'evidenceReference'],
                properties: {
                  lineId: uuid,
                  outcome: { type: 'string', enum: ['SUBMITTED', 'UNKNOWN', 'CONFIRMED', 'FAILED', 'CANCELLED'] },
                  eventKey,
                  evidenceReference: reference,
                  eventTime: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await bank(request, 'record_outcome', id);
      return withTransaction(db, (tx) => recordOutcomes(tx, grant, id, request.body as { outcomes: OutcomeInput[] }));
    },
  );

  app.post(
    '/payroll-outputs/bank-lines/:id/reversal',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['amount', 'eventKey', 'evidenceReference', 'reason'],
          properties: { amount: money, eventKey, evidenceReference: reference, reason },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await bank(request, 'record_outcome', id);
      return withTransaction(db, (tx) => reverseLine(tx, grant, id, request.body as { amount: string; eventKey: string; evidenceReference: string; reason: string }));
    },
  );

  app.get('/payroll-outputs/records/:id/payment', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return recordPayment(db, await bank(request, 'read', id), id);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // FR-107 payslips
  // ---------------------------------------------------------------------------------------------------------------
  app.get('/payroll-outputs/records/:id/payslip-preview', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return previewPayslip(db, await output(request, 'read', id), id);
  });

  app.post('/payroll-outputs/runs/:id/payslips/publish', { schema: { params: idParams } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const grant = await output(request, 'publish', id);
    const result = await withTransaction(db, (tx) => publishRunPayslips(tx, files, grant, id));
    reply.status(result.done ? 200 : 202);
    return result;
  });

  app.get('/payroll-outputs/runs/:id/payslips', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return listRunOutputs(db, await output(request, 'read', id), id);
  });

  app.get('/payroll-outputs/payslips/:id/file', { schema: { params: idParams } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return send(reply, await outputFile(db, files, await output(request, 'read', id), id), 'payslip.json');
  });

  app.post('/payroll-outputs/payslips/:id/reissue', { schema: { params: idParams, body: reasonVersionBody } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const grant = await output(request, 'publish', id);
    const result = await withTransaction(db, (tx) => reissuePayslip(tx, files, grant, id, request.body as { reason: string; expectedVersion: number }));
    reply.status(201);
    return result;
  });

  // H3 TN06: the Employee OWN context, own issued payslips only.
  app.get('/me/payslips', async (request) => ownPayslips(db, await requireAccess(db, request, 'payslip', 'read', ['payslip'], { requireAll: true })));

  app.get('/me/payslips/:id/file', { schema: { params: idParams } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'payslip', 'read', ['payslip'], { requireAll: true, recordKey: id });
    return send(reply, await ownPayslipFile(db, files, grant, id), 'payslip.json');
  });

  // H7 / TN06: the payment status of the employee's own held salary (period, state, dates; no reason or amount).
  app.get('/me/payroll-holds', { schema: { querystring: { type: 'object', additionalProperties: false, properties: { ...optionalPaging } } } }, async (request) =>
    ownHoldStatus(db, await requireAccess(db, request, 'payslip', 'read', ['payslip'], { requireAll: true }), request.query as Paging),
  );

  app.get('/me/payroll-holds/:id', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return ownHoldStatusDetail(db, await requireAccess(db, request, 'payslip', 'read', ['payslip'], { requireAll: true, recordKey: id }), id);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // FR-034 loans and advances (H3 TN15)
  // ---------------------------------------------------------------------------------------------------------------
  const loan = (request: Req, action: 'read' | 'request' | 'decide' | 'disburse' | 'recover', recordKey?: string) =>
    requireAccess(db, request, 'payroll_loan', action, ['loan'], { requireAll: true, ...(recordKey ? { recordKey } : {}) });
  const loanRequestBody = {
    type: 'object',
    additionalProperties: false,
    required: ['loanKind', 'currencyCode', 'principal', 'purpose'],
    properties: {
      loanKind: { type: 'string', enum: ['LOAN', 'ADVANCE'] },
      currencyCode: { type: 'string', pattern: '^[A-Z]{3}$' },
      principal: money,
      purpose: reason,
      interestRate: { type: 'string', maxLength: 20 },
      idempotencyKey: eventKey,
    },
  } as const;

  app.get('/me/loans', async (request) => ownLoans(db, await requireAccess(db, request, 'own_loan', 'read', ['loan'], { requireAll: true })));

  app.post('/me/loans', { schema: { body: loanRequestBody } }, async (request, reply) => {
    const grant = await requireAccess(db, request, 'own_loan', 'request', ['loan'], { requireAll: true });
    const result = await withTransaction(db, (tx) => requestOwnLoan(tx, grant, request.body as LoanRequestInput));
    reply.status(result.replayed ? 200 : 201);
    return result;
  });

  app.post('/me/loans/:id/withdraw', { schema: { params: idParams, body: reasonVersionBody } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'own_loan', 'request', ['loan'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => withdrawOwnLoan(tx, grant, id, request.body as { reason: string; expectedVersion: number }));
  });

  app.post('/payroll-outputs/employees/:id/loans', { schema: { params: idParams, body: loanRequestBody } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const grant = await loan(request, 'request', id);
    const result = await withTransaction(db, (tx) => requestLoanFor(tx, grant, id, request.body as LoanRequestInput));
    reply.status(result.replayed ? 200 : 201);
    return result;
  });

  // FR-034 "entry and upload": the LOAN_REQUESTS_V1 upload, each row exactly the request above (loan-import.ts).
  await loanImportRoutes(app, { db, files, scanner });

  app.get(
    '/payroll-outputs/loans',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { state: { type: 'string', enum: ['REQUESTED', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'CANCELLED', 'DISBURSED', 'CLOSED'] }, employeeId: uuid, ...optionalPaging },
        },
      },
    },
    async (request) => listLoans(db, await loan(request, 'read'), request.query as { state?: string; employeeId?: string } & Paging),
  );

  app.get('/payroll-outputs/loans/:id', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return loanDetail(db, await loan(request, 'read', id), id);
  });

  app.post(
    '/payroll-outputs/loans/:id/decision',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['decision', 'expectedVersion'],
          properties: {
            decision: { type: 'string', enum: ['APPROVE', 'REJECT'] },
            reason,
            recoveryComponentCode: { type: 'string', minLength: 1, maxLength: 40 },
            installments: {
              type: 'array',
              minItems: 1,
              maxItems: 600,
              items: { type: 'object', additionalProperties: false, required: ['dueMonth', 'amount'], properties: { dueMonth: { type: 'string', pattern: '^\\d{4}-\\d{2}$' }, amount: money } },
            },
            expectedVersion,
          },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await loan(request, 'decide', id);
      return withTransaction(db, (tx) => decideLoan(tx, grant, id, request.body as DecisionInput));
    },
  );

  app.post('/payroll-outputs/loans/:id/cancel', { schema: { params: idParams, body: reasonVersionBody } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await loan(request, 'decide', id);
    return withTransaction(db, (tx) => cancelLoan(tx, grant, id, request.body as { reason: string; expectedVersion: number }));
  });

  app.post(
    '/payroll-outputs/loans/:id/disbursement',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['disbursementDate', 'evidenceKey', 'evidenceReference', 'evidenceDocumentIds', 'expectedVersion'],
          properties: {
            disbursementDate: { type: 'string', format: 'date' },
            evidenceKey: eventKey,
            evidenceReference: reference,
            evidenceDocumentIds: { type: 'array', minItems: 1, maxItems: 1, items: uuid },
            expectedVersion,
          },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await loan(request, 'disburse', id);
      return withTransaction(db, (tx) => disburseLoan(tx, grant, id, request.body as DisbursementInput));
    },
  );

  // A bounded share of a run-wide operation, like the payslip publication (runWide: docs/09 §8.2).
  app.post('/payroll-outputs/runs/:id/loan-recoveries', { config: runWide, schema: { params: idParams } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const grant = await loan(request, 'recover', id);
    const result = await withTransaction(db, (tx) => recognizeRecoveries(tx, grant, id));
    reply.status(result.done ? 200 : 202);
    return result;
  });

  // ---------------------------------------------------------------------------------------------------------------
  // FR-038 reports and FR-039 statutory outputs
  // ---------------------------------------------------------------------------------------------------------------
  app.get(
    '/payroll-outputs/runs/:id/register',
    { schema: { params: idParams, querystring: { type: 'object', additionalProperties: false, properties: { after: { type: 'string', maxLength: 100 } } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      return payrollRegister(db, await report(request, id), id, request.query as { after?: string });
    },
  );

  app.get('/payroll-outputs/runs/:id/disbursement', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return disbursementReport(db, await report(request, id), id);
  });

  app.get('/payroll-outputs/runs/:id/comparison', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return comparisonReport(db, await report(request, id), id);
  });

  app.get('/payroll-outputs/runs/:id/journal', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    await report(request, id);
    return journalVoucher();
  });

  app.get('/payroll-outputs/statutory-outputs', async (request) => {
    await requireAccess(db, request, 'payroll_statutory', 'read', ['operational'], { requireAll: true });
    return statutoryOutputs();
  });

  app.get(
    '/payroll-outputs/statutory-outputs/:code',
    { schema: { params: { type: 'object', required: ['code'], properties: { code: { type: 'string', pattern: '^[A-Z0-9_]{2,40}$' } } } } },
    async (request) => {
      const { code } = request.params as { code: string };
      await requireAccess(db, request, 'payroll_statutory', 'read', ['operational'], { requireAll: true, recordKey: code });
      return statutoryOutput(code);
    },
  );
}
