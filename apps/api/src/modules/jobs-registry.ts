// Daily jobs of registered business modules. The scheduler (worker/scheduler.ts) runs each active module's jobs once
// per company-local day from their start hour; every run is claimed in scheduled_job_run, so concurrent workers never
// duplicate it. A module still being built is skipped (registry.ts).
import type { Database } from '../db/transaction.js';
import { runPolicyExpiry } from './documents/expiry.js';
import { runIncrementReviewReminders } from './increment/reminders.js';
import { separateDueExits } from './lifecycle/exit.js';
import { runPayrollHoldReviews } from './payroll/holds.js';
import { purgeExpiredEdocFiles } from './payroll-extras/edoc.js';
import { isModuleActive } from './registry.js';
import { runMissingTimesheetReminders } from './timesheet/exceptions.js';

export interface ModuleDailyJob {
  /** Module key in registry.ts. */
  key: string;
  /** Job code recorded in scheduled_job_run (A-Z, 0-9, _). */
  code: string;
  /** Company-local hour from which the job may run (0-23). */
  fromHour: number;
  run: (db: Database, companyId: string, localDate: string, systemUserId: string) => Promise<unknown>;
}

const ALL_JOBS: readonly ModuleDailyJob[] = [
  // F1: the approved last working date is inclusive; separation follows from the next day (lifecycle).
  { key: 'lifecycle', code: 'EXIT_SEPARATIONS', fromHour: 0, run: separateDueExits },
  // BR-049: a missed weekly timesheet is a reminder and an exception, never a deduction (timesheet). Morning, with the
  // other reminders.
  { key: 'timesheet', code: 'TIMESHEET_MISSED', fromHour: 8, run: runMissingTimesheetReminders },
  // H2 hold review: due holds move to EXPIRED_REVIEW; daily reminders, first escalation after 2 business days, then every
  // 5 (payroll). Morning, with the other reminders.
  { key: 'payroll', code: 'PAYROLL_HOLD_REVIEW', fromHour: 8, run: runPayrollHoldReviews },
  // DF12 document expiry for company policy versions (documents), from 08:00 with the employee document expiry notices.
  { key: 'documents', code: 'POLICY_EXPIRY', fromHour: 8, run: (db, companyId, localDate) => runPolicyExpiry(db, companyId, localDate) },
  // CL-100: payslip PDFs of EDOC exports are kept only while they can be downloaded (payroll-extras). At night, when nobody exports.
  { key: 'payroll-extras', code: 'EDOC_PURGE', fromHour: 1, run: (db, companyId) => purgeExpiredEdocFiles(db, companyId) },
];

/** Daily jobs of core modules (not in the registry, so always on). */
const CORE_JOBS: readonly ModuleDailyJob[] = [
  // DF15: review-due reminders 30, 7 and 1 days before each increment case's decision due date (core increment module).
  { key: 'increment', code: 'INCREMENT_REVIEW_DUE', fromHour: 8, run: (db, companyId, localDate, systemUserId) => runIncrementReviewReminders(db, companyId, localDate, systemUserId) },
];

export const MODULE_DAILY_JOBS: readonly ModuleDailyJob[] = [...CORE_JOBS, ...ALL_JOBS.filter((j) => isModuleActive(j.key))];
