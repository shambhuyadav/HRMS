// Route plugins of registered business modules. app.ts registers each active one under /v1 with the shared
// dependencies; a module still being built is skipped unless the run includes it (registry.ts).
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/transaction.js';
import type { FileStore } from '../storage/files.js';
import type { ScanProvider } from '../storage/scan.js';
import { appraisalRoutes } from './appraisal/routes.js';
import { assetsRoutes } from './assets/routes.js';
import { documentsRoutes } from './documents/routes.js';
import { hiringRoutes } from './hiring/routes.js';
import { lifecycleRoutes } from './lifecycle/routes.js';
import { payrollRoutes } from './payroll/routes.js';
import { payrollOutputsRoutes } from './payroll-outputs/routes.js';
import { isModuleActive } from './registry.js';
import { sensitiveChangeRoutes } from './sensitive-change/routes.js';
import { timesheetRoutes } from './timesheet/routes.js';
import { trainingRoutes } from './training/routes.js';

/** Shared dependencies of module routes. `scanner` quarantines user uploads until released (FR-106, storage/scan.ts). */
export type ModuleRoutes = (app: FastifyInstance, opts: { db: Database; files: FileStore; scanner: ScanProvider }) => Promise<void>;

const ALL_ROUTES: readonly { key: string; routes: ModuleRoutes }[] = [
  { key: 'sensitive-change', routes: sensitiveChangeRoutes },
  { key: 'hiring', routes: hiringRoutes },
  { key: 'appraisal', routes: appraisalRoutes },
  { key: 'training', routes: trainingRoutes },
  { key: 'timesheet', routes: timesheetRoutes },
  { key: 'lifecycle', routes: lifecycleRoutes },
  { key: 'payroll', routes: payrollRoutes },
  { key: 'payroll-outputs', routes: payrollOutputsRoutes },
  { key: 'assets', routes: assetsRoutes },
  { key: 'documents', routes: documentsRoutes },
];

export const MODULE_ROUTES: readonly { key: string; routes: ModuleRoutes }[] = ALL_ROUTES.filter((r) => isModuleActive(r.key));
