// Monthly leave-balance upload (the reference system's "Upload Monthly Leave Balance", beside BRD coverage CL-058 "Upload Opening
// Leave Balance"; FR-025 "a leave ledger ... rather than an untraceable editable total", "an adjustment preserves actor and
// reason"; DF05 "no negative paid balance"; DF09 imports). Built 10 Nov 2026; decided under owner delegation (6 Nov 2026;
// recorded 10 Nov 2026):
//
// Template LEAVE_MONTHLY_ADJUSTMENT_V1: employeeCode,leaveType,month,units,reason. Each row is one ADJUSTMENT movement in the
// employee's leave ledger, dated the last day of the month (YYYY-MM), of the signed units given (up to 4 decimals, never 0),
// with the reason, through the single adjustment route's own path (adjustBalance: row scope, never one's own balance, the
// balance lock, audit with actor and reason). Nothing is overwritten: the ledger keeps every movement, and the balance is
// opening plus credits minus debits as before. The preview shows each row's balance at the month end before and after.
//
// - One upload adjustment per employee, leave type and month: the movement's ledger key is that triple, so the same file
//   uploaded again (under any idempotency key) is rejected whole (MONTH_ALREADY_ADJUSTED) and the database's unique key refuses
//   any other path to a second one. A further correction of the same month is a single adjustment with its own reason.
// - A deduction may not take a paid leave type below zero, neither at the month end nor overall (units already reserved for
//   later leave included): NEGATIVE_BALANCE (DF05). An HR exception beyond that is a single adjustment with its reason.
// - The month must fall within the employment: not before the month of joining, nor after the month of an approved last working
//   date (NOT_EMPLOYED_IN_MONTH); and it must have started (FUTURE_MONTH): the current month is the latest.
// Batches are all-or-nothing (imports/batch.ts); the caller's own batches are listed and one held for the malware scan is
// resumed from its stored file (imports/routes.ts).
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../db/transaction.js';
import { notFound } from '../../http/errors.js';
import { requireAccess } from '../../http/guard.js';
import type { FileStore } from '../../storage/files.js';
import type { ScanProvider } from '../../storage/scan.js';
import { type AccessGrant, canAccessEmployee } from '../access/authorize.js';
import { markRepeats, MAX_BATCH_BYTES, parseTemplate, RowError, type Template } from '../imports/batch.js';
import { type BatchSpec, cancelBatch, commitBatch, jobView, submitBatch } from '../imports/jobs.js';
import { batchFollowUpRoutes } from '../imports/routes.js';
import { adjustBalance, lockBalance } from './service.js';

const COLUMNS = ['employeeCode', 'leaveType', 'month', 'units', 'reason'] as const;
type Column = (typeof COLUMNS)[number];
export const LEAVE_MONTHLY_ADJUSTMENT_TEMPLATE: Template<Column> = { code: 'LEAVE_MONTHLY_ADJUSTMENT_V1', columns: COLUMNS };

/** Signed units, up to the ledger's 4 decimals. */
const SIGNED_UNITS = /^[+-]?\d{1,4}(\.\d{1,4})?$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

const rowKey = (row: Record<Column, string>) => `${row.employeeCode.toUpperCase()}@${row.leaveType.toUpperCase()}@${row.month}`;

/** The last day of a month (YYYY-MM). */
export function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** The ledger key of the one upload adjustment of an employee, leave type and month. */
export const monthlyAdjustmentKey = (employeeId: string, leaveTypeId: string, month: string) => `leave:monthly-upload:${employeeId}:${leaveTypeId}:${month}`;

export const LEAVE_MONTHLY_ADJUSTMENT_SPEC: BatchSpec<Column> = {
  kind: 'leave_monthly_adjustment',
  template: LEAVE_MONTHLY_ADJUSTMENT_TEMPLATE,
  parse: (bytes) => markRepeats(parseTemplate(bytes, LEAVE_MONTHLY_ADJUSTMENT_TEMPLATE), rowKey, 'DUPLICATE_IN_BATCH'),
  keyOf: (row, n) => (row.employeeCode ? rowKey(row) : `ROW-${n}`),
  async apply(client, grant: AccessGrant, row) {
    if (!SIGNED_UNITS.test(row.units) || Number(row.units) === 0) throw new RowError('INVALID_UNITS');
    if (!MONTH.test(row.month)) throw new RowError('INVALID_MONTH');
    // A month that has not started yet is not adjusted ahead of time (its own upload comes when it does).
    if (row.month > grant.businessDate.slice(0, 7)) throw new RowError('FUTURE_MONTH');
    if (row.reason === '' || row.reason.length > 500) throw new RowError('INVALID_REASON');
    const units = row.units.replace(/^\+/, '');
    const end = monthEnd(row.month);
    const employee = (
      await client.query<{ id: string; employed: boolean }>(
        `select e.id, e.joining_date <= $3::date and coalesce(hrms_exit_last_working_date(e.company_id, e.id) >= date_trunc('month', $3::date)::date, true) as employed
           from employee e where e.company_id = $1 and e.employee_code = $2`,
        [grant.companyId, row.employeeCode.toUpperCase(), end],
      )
    ).rows[0];
    if (!employee) throw new RowError('UNKNOWN_EMPLOYEE');
    // Nothing about an employee outside the row scope is read, not even their balance.
    if (!(await canAccessEmployee(client, grant, employee.id))) throw new RowError('OUT_OF_SCOPE');
    const type = (await client.query<{ id: string; code: string; paid: boolean }>(`select id, code, paid from leave_type where company_id = $1 and code = $2`, [grant.companyId, row.leaveType.toUpperCase()])).rows[0];
    if (!type) throw new RowError('UNKNOWN_LEAVE_TYPE');
    if (!employee.employed) throw new RowError('NOT_EMPLOYED_IN_MONTH');
    const ledgerKey = monthlyAdjustmentKey(employee.id, type.id, row.month);
    // The checks below and the movement run under the balance lock adjustBalance takes again (re-entrant in the transaction).
    await lockBalance(client, employee.id, type.id);
    if ((await client.query(`select 1 from leave_movement where company_id = $1 and idempotency_key = $2`, [grant.companyId, ledgerKey])).rowCount) throw new RowError('MONTH_ALREADY_ADJUSTED');
    const balance = (
      await client.query<{ before: string; after: string; negative: boolean }>(
        `select coalesce(sum(units) filter (where effective_date <= $4::date), 0)::numeric(12,4)::text as before,
                (coalesce(sum(units) filter (where effective_date <= $4::date), 0) + $5::numeric)::numeric(12,4)::text as after,
                (coalesce(sum(units) filter (where effective_date <= $4::date), 0) + $5::numeric < 0 or coalesce(sum(units), 0) + $5::numeric < 0) as negative
           from leave_movement where company_id = $1 and employee_id = $2 and leave_type_id = $3`,
        [grant.companyId, employee.id, type.id, end, units],
      )
    ).rows[0]!;
    if (type.paid && Number(units) < 0 && balance.negative) throw new RowError('NEGATIVE_BALANCE');
    const { replayed } = await adjustBalance(client, grant, {
      employeeId: employee.id,
      leaveType: type.code,
      kind: 'ADJUSTMENT',
      units,
      effectiveDate: end,
      reason: row.reason,
      idempotencyKey: `monthly-upload:${randomUUID()}`,
      ledgerKey,
    });
    if (replayed) throw new RowError('MONTH_ALREADY_ADJUSTED');
    return { balanceAtMonthEnd: { from: balance.before, to: balance.after } };
  },
};

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
export const LEAVE_MONTHLY_ADJUSTMENT_PATH = '/leave/monthly-adjustment-imports';
const PATH = LEAVE_MONTHLY_ADJUSTMENT_PATH;

async function grants(db: Database, request: Parameters<typeof requireAccess>[1], recordKey?: string) {
  await requireAccess(db, request, 'leave', 'import', ['operational'], { requireAll: true, ...(recordKey ? { recordKey } : {}) });
  // Rows are applied under the caller's adjustment grant, so its scope still applies per row.
  return requireAccess(db, request, 'leave', 'adjust', ['operational'], { requireAll: true, ...(recordKey ? { recordKey } : {}) });
}

export async function leaveMonthlyAdjustmentImportRoutes(app: FastifyInstance, opts: { db: Database; files: FileStore; scanner: ScanProvider }): Promise<void> {
  const { db, files, scanner } = opts;

  app.post(
    PATH,
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
      const grant = await grants(db, request);
      const { status, view } = await submitBatch(db, files, scanner, grant, LEAVE_MONTHLY_ADJUSTMENT_SPEC, request.body as { fileName: string; contentBase64: string; idempotencyKey: string });
      reply.status(status);
      return view;
    },
  );

  app.get(`${PATH}/:id`, { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'leave', 'import', ['operational'], { requireAll: true, recordKey: id });
    const view = await jobView(db, grant, LEAVE_MONTHLY_ADJUSTMENT_SPEC.kind, id);
    if (!view) throw notFound();
    return view;
  });

  // The caller's own batches (read grant), resuming one held for the malware scan and the template (upload grants; imports/routes.ts).
  batchFollowUpRoutes(app, {
    db,
    files,
    scanner,
    path: PATH,
    spec: LEAVE_MONTHLY_ADJUSTMENT_SPEC,
    readGrant: (request) => requireAccess(db, request, 'leave', 'import', ['operational'], { requireAll: true }),
    submitGrant: (request, id) => grants(db, request, id),
  });

  app.post(`${PATH}/:id/commit`, { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await grants(db, request, id);
    return commitBatch(db, files, grant, LEAVE_MONTHLY_ADJUSTMENT_SPEC, id);
  });

  app.post(`${PATH}/:id/cancel`, { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'leave', 'import', ['operational'], { requireAll: true, recordKey: id });
    return cancelBatch(db, grant, LEAVE_MONTHLY_ADJUSTMENT_SPEC.kind, id);
  });
}
