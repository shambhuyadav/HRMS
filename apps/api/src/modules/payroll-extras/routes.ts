// Routes of the payroll-extras module (batch R3: CL-074, CL-081, CL-084, CL-085, CL-097, CL-098, CL-100, CL-113, CL-119). Registered by
// app.ts; nothing is served while the module is not active (modules/registry.ts). Every route resolves its grant first (requireAccess);
// writes run in one transaction with their audit record; uploads go through the shared import framework (stage -> preview -> commit).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database } from '../../db/transaction.js';
import { withTransaction } from '../../db/transaction.js';
import { HttpError, notFound } from '../../http/errors.js';
import { auditDenial, requireAccess } from '../../http/guard.js';
import type { FileStore } from '../../storage/files.js';
import type { ScanProvider } from '../../storage/scan.js';
import { type AccessGrant, resolveAccess } from '../access/authorize.js';
import { enqueueBulkJob } from '../bulk/service.js';
import { MAX_BATCH_BYTES } from '../imports/batch.js';
import { type BatchSpec, cancelBatch, commitBatch, jobView, submitBatch } from '../imports/jobs.js';
import { batchFollowUpRoutes } from '../imports/routes.js';
import { isModuleActive } from '../registry.js';
import {
  CHALLAN_STATUTES,
  type ChallanSettingInput,
  cancelTdsChallan,
  challanAsSeen,
  createChallanSetting,
  listChallanSettings,
  listTdsChallans,
  recordTdsChallan,
  type TdsChallanInput,
  tdsChallanSpec,
  tdsReconciliation,
} from './challans.js';
import { isCompanyWide, MODULE_KEY, requireCompanyWide } from './common.js';
import { auditEdocRequest, checkEdocMonth, EDOC_KIND, EDOC_SCOPE_CHANGED, edocArchive, openEdocExport } from './edoc.js';
import { createGlMapping, type GlMappingInput, listGlMappings, salaryJv } from './jv.js';
import { checkAsOf, liabilityProvisions } from './liabilities.js';
import { medicalClaimRows } from './medical.js';
import { assertFiscalYear, listTaxInputs, pastSalarySpec, perquisiteSpec } from './tax-inputs.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const date = { type: 'string', format: 'date' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const fiscalYearQuery = {
  type: 'object',
  additionalProperties: false,
  required: ['fiscalYear'],
  properties: { fiscalYear: { type: 'string', pattern: '^\\d{4}-\\d{2}$' } },
} as const;
const text = (max: number) => ({ anyOf: [{ type: 'string', maxLength: max }, { type: 'null' }] }) as const;

type Grant = (request: FastifyRequest, recordKey?: string) => Promise<AccessGrant>;

/**
 * One upload through the import framework at `path`: POST uploads (preview), GET /:id reads the caller's batch, the shared follow-up
 * routes list, resume and serve the template, POST /:id/commit applies it all or nothing, POST /:id/cancel drops it. The spec is made
 * per batch so a committed row records the batch it came from.
 */
function importRoutes<C extends string>(app: FastifyInstance, o: { db: Database; files: FileStore; scanner: ScanProvider; path: string; spec: (jobId: string | null) => BatchSpec<C>; grant: Grant }) {
  const preview = o.spec(null);
  app.post(
    o.path,
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
      const grant = await o.grant(request);
      const { status, view } = await submitBatch(o.db, o.files, o.scanner, grant, preview, request.body as { fileName: string; contentBase64: string; idempotencyKey: string });
      reply.status(status);
      return view;
    },
  );
  app.get(`${o.path}/:id`, { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const view = await jobView(o.db, await o.grant(request, id), preview.kind, id);
    if (!view) throw notFound();
    return view;
  });
  batchFollowUpRoutes(app, { db: o.db, files: o.files, scanner: o.scanner, path: o.path, spec: preview, readGrant: (request) => o.grant(request), submitGrant: (request, id) => o.grant(request, id) });
  app.post(`${o.path}/:id/commit`, { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return commitBatch(o.db, o.files, await o.grant(request, id), o.spec(id), id);
  });
  app.post(`${o.path}/:id/cancel`, { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return cancelBatch(o.db, await o.grant(request, id), preview.kind, id);
  });
}

export async function payrollExtrasRoutes(app: FastifyInstance, opts: { db: Database; files: FileStore; scanner: ScanProvider }): Promise<void> {
  // A module still being built serves nothing outside the runs that include it (registry.ts HRMS_DRAFT_MODULES).
  if (!isModuleActive(MODULE_KEY)) return;
  const { db, files, scanner } = opts;
  const access = (resource: string, action: string, fieldGroup: string) => (request: FastifyRequest, recordKey?: string) =>
    requireAccess(db, request, resource, action, [fieldGroup], { requireAll: true, ...(recordKey ? { recordKey } : {}) });
  const challanRead = access('payroll_challan', 'read', 'operational');
  const challanManage = access('payroll_challan', 'manage', 'operational');
  const companyChallanManage: Grant = async (request, recordKey) => {
    const grant = await challanManage(request, recordKey);
    requireCompanyWide(grant);
    return grant;
  };
  const taxInputImport = access('payroll_tax_input', 'import', 'amount');
  const mappingRead = access('payroll_gl_mapping', 'read', 'operational');
  const mappingManage = access('payroll_gl_mapping', 'manage', 'operational');
  const reportRead = access('payroll_report', 'read', 'amount');
  const edocExport = access('payroll_output', 'export', 'amount');
  /**
   * CL-081: the amounts of TDS challans are company payroll figures, not challan configuration: shown to a challan reader only when the
   * same assignment also holds payroll_report.read.amount, company-wide (no filter, no scoped DENY); otherwise they read null.
   */
  const seesChallanAmounts = async (grant: AccessGrant) => {
    const d = await resolveAccess(db, { userId: grant.userId, companyId: grant.companyId, assignmentId: grant.assignmentId, resource: 'payroll_report', action: 'read', fieldGroups: ['amount'] });
    return d.allowed && isCompanyWide(d);
  };

  // ---- CL-074 challan master -----------------------------------------------------------------------------------------------
  app.get('/payroll-extras/challan-settings', async (request) => {
    const grant = await challanRead(request);
    return listChallanSettings(db, grant, grant.businessDate);
  });
  app.post(
    '/payroll-extras/challan-settings',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['statute', 'effectiveFrom', 'bankName', 'reason'],
          properties: {
            statute: { type: 'string', enum: [...CHALLAN_STATUTES] },
            effectiveFrom: date,
            tan: text(10),
            establishmentCode: text(30),
            bankName: { type: 'string', maxLength: 120 },
            bankBranch: text(120),
            bsrCode: text(7),
            reason: { type: 'string', maxLength: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      const grant = await challanManage(request);
      const created = await withTransaction(db, (tx) => createChallanSetting(tx, grant, request.body as ChallanSettingInput));
      reply.status(201);
      return created;
    },
  );

  // ---- CL-081 TDS challans -------------------------------------------------------------------------------------------------
  app.get('/payroll-extras/tds-challans', { schema: { querystring: fiscalYearQuery } }, async (request) => {
    const grant = await challanRead(request);
    return listTdsChallans(db, grant, (request.query as { fiscalYear: string }).fiscalYear, { amounts: await seesChallanAmounts(grant) });
  });
  app.post(
    '/payroll-extras/tds-challans',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['month', 'section', 'bsrCode', 'challanSerial', 'depositDate', 'amount'],
          properties: {
            // Lengths are bounded here; formats are the service's own checks (the upload's row codes, in plain words).
            month: { type: 'string', maxLength: 20 },
            section: { type: 'string', maxLength: 20 },
            bsrCode: { type: 'string', maxLength: 20 },
            challanSerial: { type: 'string', maxLength: 20 },
            depositDate: { type: 'string', maxLength: 20 },
            amount: { type: 'string', maxLength: 30 },
          },
        },
      },
    },
    async (request, reply) => {
      const grant = await challanManage(request);
      const created = await withTransaction(db, (tx) => recordTdsChallan(tx, grant, request.body as TdsChallanInput));
      reply.status(201);
      return created;
    },
  );
  app.post(
    '/payroll-extras/tds-challans/:id/cancel',
    {
      schema: {
        params: idParams,
        body: { type: 'object', additionalProperties: false, required: ['reason', 'expectedVersion'], properties: { reason: { type: 'string', maxLength: 500 }, expectedVersion: { type: 'integer', minimum: 1 } } },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await challanManage(request, id);
      const amounts = await seesChallanAmounts(grant);
      return challanAsSeen(await withTransaction(db, (tx) => cancelTdsChallan(tx, grant, id, request.body as { reason: string; expectedVersion: number })), amounts);
    },
  );
  importRoutes(app, { db, files, scanner, path: '/payroll-extras/tds-challan-imports', spec: tdsChallanSpec, grant: companyChallanManage });
  // Form 24Q link: challans against the working data's TDS deducted, month by month (company figures: the payroll report grant too).
  app.get('/payroll-extras/tds-reconciliation', { schema: { querystring: fiscalYearQuery } }, async (request) => {
    await challanRead(request);
    const grant = await reportRead(request);
    return tdsReconciliation(db, grant, (request.query as { fiscalYear: string }).fiscalYear);
  });

  // ---- CL-085 perquisites, CL-084 / CL-119 past salary ---------------------------------------------------------------------
  importRoutes(app, { db, files, scanner, path: '/payroll-extras/perquisite-imports', spec: perquisiteSpec, grant: taxInputImport });
  importRoutes(app, { db, files, scanner, path: '/payroll-extras/past-salary-imports', spec: pastSalarySpec, grant: taxInputImport });
  app.get(
    '/payroll-extras/tax-inputs',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['fiscalYear'],
          properties: { fiscalYear: { type: 'string', pattern: '^\\d{4}-\\d{2}$' }, search: { type: 'string', maxLength: 100 }, employeeId: uuid },
        },
      },
    },
    async (request) => {
      const grant = await access('payroll_tax_input', 'read', 'amount')(request);
      const q = request.query as { fiscalYear: string; search?: string; employeeId?: string };
      assertFiscalYear(q.fiscalYear);
      return listTaxInputs(db, grant, q);
    },
  );

  // ---- CL-113 medical claims -----------------------------------------------------------------------------------------------
  app.get(
    '/payroll-extras/medical-claims',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['from', 'to'],
          properties: { from: date, to: date, search: { type: 'string', maxLength: 100 }, departmentId: uuid },
        },
      },
    },
    async (request) => {
      const grant = await access('expense', 'read', 'operational')(request);
      const q = request.query as { from: string; to: string; search?: string; departmentId?: string };
      return { from: q.from, to: q.to, items: await medicalClaimRows(db, grant, q) };
    },
  );

  // ---- CL-098 liability provisions -----------------------------------------------------------------------------------------
  app.get(
    '/payroll-extras/liability-provisions',
    { schema: { querystring: { type: 'object', additionalProperties: false, required: ['asOf'], properties: { asOf: date, departmentId: uuid } } } },
    async (request) => {
      const grant = await reportRead(request);
      const q = request.query as { asOf: string; departmentId?: string };
      // Worked from salaries: the salary read grant in the same assignment, and the salary history grant for an earlier date (C4), as
      // the salary progression route resolves them (refusals audited); liabilityProvisions checks them again with the rows.
      await requireAccess(db, request, 'salary', 'read', ['salary'], { requireAll: true });
      const asOf = checkAsOf(q.asOf, grant.businessDate);
      if (asOf < grant.businessDate) await requireAccess(db, request, 'salary', 'history_read', ['salary'], { requireAll: true });
      return liabilityProvisions(db, grant, q);
    },
  );

  // ---- CL-097 GL mapping and salary JV -------------------------------------------------------------------------------------
  app.get('/payroll-extras/gl-mappings', async (request) => {
    const grant = await mappingRead(request);
    return listGlMappings(db, grant, grant.businessDate);
  });
  app.post(
    '/payroll-extras/gl-mappings',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['effectiveFrom', 'netPayAccountCode', 'reason', 'lines'],
          properties: {
            effectiveFrom: date,
            netPayAccountCode: { type: 'string', maxLength: 40 },
            netPayAccountName: text(120),
            reason: { type: 'string', maxLength: 500 },
            lines: {
              type: 'array',
              minItems: 1,
              maxItems: 500,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['componentCode', 'accountCode'],
                properties: {
                  componentCode: { type: 'string', maxLength: 40 },
                  accountCode: { type: 'string', maxLength: 40 },
                  accountName: text(120),
                  payableAccountCode: text(40),
                  payableAccountName: text(120),
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const grant = await mappingManage(request);
      const created = await withTransaction(db, (tx) => createGlMapping(tx, grant, request.body as GlMappingInput));
      reply.status(201);
      return created;
    },
  );
  app.get('/payroll-extras/runs/:id/salary-jv', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return salaryJv(db, await reportRead(request, id), id);
  });

  // ---- CL-100 EDOC export --------------------------------------------------------------------------------------------------
  app.post(
    '/payroll-extras/edoc-exports',
    {
      schema: {
        body: { type: 'object', additionalProperties: false, required: ['month'], properties: { month: { type: 'string', maxLength: 7 }, idempotencyKey: { type: 'string', minLength: 8, maxLength: 200 } } },
      },
    },
    async (request, reply) => {
      const grant = await edocExport(request);
      const body = request.body as { month: string; idempotencyKey?: string };
      const month = checkEdocMonth(body.month);
      if (month > grant.businessDate.slice(0, 7)) throw new HttpError(422, 'FUTURE_MONTH', 'This month has not started yet');
      const job = await withTransaction(db, async (tx) => {
        // NFR-S09: one export of a month per requester at a time; a repeat while one is queued, running or still downloadable answers it.
        const open = await openEdocExport(tx, grant, month);
        if (open) return { ...open, existing: true };
        const queued = await enqueueBulkJob(tx, grant, EDOC_KIND, { month }, body.idempotencyKey);
        await auditEdocRequest(tx, grant, queued.jobId, month);
        return { ...queued, existing: false };
      });
      reply.status(202);
      return { ...job, statusPath: `/v1/bulk-jobs/${job.jobId}`, downloadPath: `/v1/payroll-extras/edoc-exports/${job.jobId}/download` };
    },
  );
  app.get('/payroll-extras/edoc-exports/:id/download', { schema: { params: idParams } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const grant = await edocExport(request, id);
    const archive = await withTransaction(db, (tx) => edocArchive(tx, grant, id)).catch(async (e: unknown) => {
      // FR-098: an archive withheld because the scope narrowed leaves redacted evidence (no names, no amounts).
      if (e instanceof HttpError && e.code === EDOC_SCOPE_CHANGED) await auditDenial(db, request, { resource: 'payroll_edoc_export', action: 'export', reason: 'SCOPE_NARROWED', recordKey: id });
      throw e;
    });
    reply.header('content-type', 'application/zip').header('content-disposition', `attachment; filename="${archive.fileName}"`).header('cache-control', 'no-store');
    return archive.content;
  });
}
