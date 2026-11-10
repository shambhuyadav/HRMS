// Employee processes, letters and exit (FR-015 to FR-018, FR-051 to FR-055; F1 exit and employee processes): HTTP routes.
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../db/transaction.js';
import type { FileStore } from '../../storage/files.js';
import type { ScanProvider } from '../../storage/scan.js';
import { deliveryRoutes } from './delivery-routes.js';
import { exitRoutes } from './exit-routes.js';
import { letterRoutes } from './letter-routes.js';
import { noteRegisterRoutes } from './notes-register.js';
import { processRoutes } from './process-routes.js';
import { settlementCalculationRoutes } from './settlement-calculation-routes.js';
import { settlementImportRoutes } from './settlement-import.js';
import { settlementRoutes } from './settlement-routes.js';
import { statutoryRoutes } from '../statutory/routes.js';

/** `scanner` releases user uploads (task evidence) from quarantine (FR-106, storage/scan.ts). */
export async function lifecycleRoutes(app: FastifyInstance, opts: { db: Database; files: FileStore; scanner: ScanProvider }): Promise<void> {
  await processRoutes(app, opts);
  await exitRoutes(app, opts);
  await letterRoutes(app, opts);
  // CL-040 (0260): the notes register, voiding a note, its supporting file and the bulk upload.
  await noteRegisterRoutes(app, opts);
  await settlementRoutes(app, opts);
  // FR-052 (I-88): calculation, notice waiver, settlement policy and the statutory rule pack registry.
  await settlementCalculationRoutes(app, opts);
  // I-85: retiring a statutory pack revision, and the PF option and PT state settings the statutory evaluator reads.
  await statutoryRoutes(app, opts);
  await settlementImportRoutes(app, opts);
  await deliveryRoutes(app, opts);
}
