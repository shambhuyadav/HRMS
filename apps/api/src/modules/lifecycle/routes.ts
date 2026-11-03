// Employee processes, letters and exit (FR-015 to FR-018, FR-051 to FR-055; F1 exit and employee processes): HTTP routes.
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../db/transaction.js';
import type { FileStore } from '../../storage/files.js';
import type { ScanProvider } from '../../storage/scan.js';
import { exitRoutes } from './exit-routes.js';
import { letterRoutes } from './letter-routes.js';
import { processRoutes } from './process-routes.js';
import { settlementImportRoutes } from './settlement-import.js';
import { settlementRoutes } from './settlement-routes.js';

/** `scanner` releases user uploads (task evidence) from quarantine (FR-106, storage/scan.ts). */
export async function lifecycleRoutes(app: FastifyInstance, opts: { db: Database; files: FileStore; scanner: ScanProvider }): Promise<void> {
  await processRoutes(app, opts);
  await exitRoutes(app, opts);
  await letterRoutes(app, opts);
  await settlementRoutes(app, opts);
  await settlementImportRoutes(app, opts);
}
