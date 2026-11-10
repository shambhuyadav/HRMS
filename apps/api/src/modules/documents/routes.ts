// FR-010 documents over HTTP: company policy documents and bulk document mapping. Every route calls requireAccess
// first; uploads are quarantined and scanned with the shared scanner (FR-106).
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../db/transaction.js';
import type { FileStore } from '../../storage/files.js';
import type { ScanProvider } from '../../storage/scan.js';
import { documentMappingRoutes } from './mapping.js';
import { companyPolicyRoutes } from './policies.js';
import { documentRequirementRoutes } from './requirements.js';

export async function documentsRoutes(app: FastifyInstance, opts: { db: Database; files: FileStore; scanner: ScanProvider }): Promise<void> {
  await companyPolicyRoutes(app, opts);
  await documentMappingRoutes(app, opts);
  // CL-150 (0261): the mandatory document types the compliance report reads.
  await documentRequirementRoutes(app, opts);
}
