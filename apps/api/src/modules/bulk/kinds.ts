// Bulk-job kinds (NFR-S09; ADR-15). Each kind names the permission it is enqueued under (the route guard, every chunk
// and every status read resolve exactly this), an optional extra authority rule, how one bounded chunk runs in the
// kind's stable order, and the record written once when the last chunk commits. The business rules stay in the owning
// module; a kind only says where and how its loop runs. A new kind adds an entry here and its code to the bulk_job
// kind check (a migration; 0055 added the increment review opening).
// The result is a small running record (counts and the fixed values of the run), copied and rewritten by every chunk,
// so it must not grow with the units: a per-unit outcome that must be listed is written as rows by the chunk that
// produced it, keyed by the job (the increment review opening's cases and exclusions, 0057; attendance processing's
// employees without a policy, 0058), in the chunk's transaction, idempotent per job and unit, and read through a
// paged route.
import type { Queryable } from '../../db/queryable.js';
import type { AccessGrant } from '../access/authorize.js';
import { auditProcessing, emptyProcessingTotals, type ProcessingTotals, processDateChunk, recordProcessingFailure } from '../attendance/service.js';
import { cycleManagementAuthorised } from '../increment/cycles.js';
import { emptyReviewTotals, openReviewChunk, recordReviewOpening, reviewOfJob, type ReviewTotals } from '../increment/roster.js';
import { accrualAuthorised, type AccrualTotals, accrueMonthChunk, auditAccrual, auditYearEnd, emptyYearEndTotals, yearEndChunk, type YearEndTotals } from '../leave/service.js';

export interface BulkPermission {
  resource: string;
  action: string;
  /** All are required (requireAll), as for the synchronous route. */
  fieldGroups: readonly string[];
}

export interface ChunkOutcome {
  /** Running totals after this chunk (operational counts and fixed scalars only; never a list that grows per unit). */
  result: Record<string, unknown>;
  /** Units covered by this chunk. */
  processed: number;
  /** Last unit covered so far, in the kind's stable order. */
  cursor: string | null;
  /** No unit remains after this chunk. */
  done: boolean;
}

export interface BulkKind {
  permission: BulkPermission;
  /** A rule beyond the permission (e.g. company scope), checked at enqueue, for every chunk and on status reads. */
  authorised?: (grant: AccessGrant) => boolean;
  initialResult(parameters: Record<string, unknown>): Record<string, unknown>;
  /** One bounded chunk: up to `size` units after `cursor`, under `grant`; `jobId` keys any per-unit rows it writes. */
  runChunk(
    tx: Queryable,
    grant: AccessGrant,
    parameters: Record<string, unknown>,
    result: Record<string, unknown>,
    cursor: string | null,
    size: number,
    jobId: string,
  ): Promise<ChunkOutcome>;
  /** Written exactly once, in the transaction of the last chunk: the audit record the synchronous run wrote. */
  complete(tx: Queryable, grant: AccessGrant, parameters: Record<string, unknown>, result: Record<string, unknown>, jobId: string): Promise<void>;
  /**
   * Records the unit a failing chunk stopped on (retry.ts UnitFailure), after the chunk's rollback, next to the job's own
   * failure record. It adds to what the requester can read; the job's outcome stays the same.
   */
  recordFailure?(tx: Queryable, job: { companyId: string; jobId: string; requestedBy: string }, unit: string, errorCode: string): Promise<void>;
}

export const BULK_JOB_KINDS = ['ATTENDANCE_PROCESSING', 'LEAVE_ACCRUAL', 'INCREMENT_REVIEW_OPENING', 'LEAVE_YEAR_END'] as const;
export type BulkJobKind = (typeof BULK_JOB_KINDS)[number];

export const BULK_KINDS: Record<BulkJobKind, BulkKind> = {
  // FR-022 daily processing of one work date over the requester's row scope (POST /v1/attendance/processing). The
  // result holds counts; each chunk writes the employees it found without a policy as rows of the job (GET
  // /v1/attendance/processing/:id/no-policy-employees, the requester under the same permission and row scope).
  ATTENDANCE_PROCESSING: {
    permission: { resource: 'attendance', action: 'process', fieldGroups: ['operational'] },
    initialResult: (p) => ({ ...emptyProcessingTotals(p.workDate as string) }),
    runChunk: async (tx, grant, p, result, cursor, size, jobId) => {
      const { totals, ...out } = await processDateChunk(tx, grant, jobId, p.workDate as string, result as unknown as ProcessingTotals, cursor, size);
      return { ...out, result: { ...totals } };
    },
    complete: (tx, grant, _p, result) => auditProcessing(tx, grant, result as unknown as ProcessingTotals),
    recordFailure: recordProcessingFailure,
  },
  // DF05 monthly accrual over every employee in service during the month (up to an approved last working date) and
  // every paid leave type (POST /v1/leave/accruals); an unrestricted company scope only (accrualAuthorised).
  LEAVE_ACCRUAL: {
    permission: { resource: 'leave', action: 'accrue', fieldGroups: ['operational'] },
    authorised: accrualAuthorised,
    initialResult: (p) => ({ month: p.month as string, credited: 0 }),
    runChunk: async (tx, grant, p, result, cursor, size) => {
      const { totals, ...out } = await accrueMonthChunk(tx, grant, p.month as string, result as unknown as AccrualTotals, cursor, size);
      return { ...out, result: { ...totals } };
    },
    complete: (tx, grant, _p, result) => auditAccrual(tx, grant, result as unknown as AccrualTotals),
  },
  // FR-024/FR-025 year-end expiry above the carry cap (I-78 item 3; POST /v1/leave/year-end-runs): the accrual duty and an
  // unrestricted company scope, as for the accrual. The result holds counts; skipped pending requests are read live (GET
  // /v1/leave/year-end-runs/pending-requests), and a later run of the same year end takes them.
  LEAVE_YEAR_END: {
    permission: { resource: 'leave', action: 'accrue', fieldGroups: ['operational'] },
    authorised: accrualAuthorised,
    initialResult: (p) => ({ ...emptyYearEndTotals(p.yearEnd as string) }),
    runChunk: async (tx, grant, p, result, cursor, size) => {
      const { totals, ...out } = await yearEndChunk(tx, grant, p.yearEnd as string, result as unknown as YearEndTotals, cursor, size);
      return { ...out, result: { ...totals } };
    },
    complete: (tx, grant, _p, result) => auditYearEnd(tx, grant, result as unknown as YearEndTotals),
  },
  // FR-091/DF15 opening of an increment cycle review for a year or a month (POST /v1/increment-cycles/:id/reviews):
  // the cycle duty in an unrestricted company-scope assignment, as for every cycle change; each chunk also checks the
  // cycle again (this company's activated revision, in force for the period) under the cycle code lock. The result
  // holds counts; each chunk writes its created cases and exclusions as rows of the job (GET
  // /v1/increment-review-openings/:id/cases and /exclusions).
  INCREMENT_REVIEW_OPENING: {
    permission: { resource: 'increment_cycle', action: 'manage', fieldGroups: ['operational'] },
    authorised: cycleManagementAuthorised,
    initialResult: (p) => {
      const { cycleId, input } = reviewOfJob(p);
      return { ...emptyReviewTotals(cycleId, input) };
    },
    runChunk: async (tx, grant, p, result, cursor, size, jobId) => {
      const { cycleId, input } = reviewOfJob(p);
      const { totals, ...out } = await openReviewChunk(tx, grant, jobId, cycleId, input, result as unknown as ReviewTotals, cursor, size);
      return { ...out, result: { ...totals } };
    },
    complete: (tx, grant, _p, result, jobId) => recordReviewOpening(tx, grant, jobId, result as unknown as ReviewTotals),
  },
};

export const isBulkJobKind = (kind: string): kind is BulkJobKind => (BULK_JOB_KINDS as readonly string[]).includes(kind);
