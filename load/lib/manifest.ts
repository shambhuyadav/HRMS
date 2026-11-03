// Fixture manifest: what the generator needs to act as each synthetic identity. manifest.json holds the summary;
// identities.ndjson holds one identity per line so a distributed generator can stream its shard of a very large
// fixture. The identity file carries live bearer tokens of synthetic accounts: keep it out of version control and
// out of shared logs, and let the sessions expire after the run (12 hours at most, DF10).
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { CompanyTier } from './plan.js';

export const MANIFEST_SCHEMA = 'hrms-load-fixture/2';
export const IDENTITIES_FILE = 'identities.ndjson';

export type ScopeKind = 'OWN' | 'TEAM' | 'ASSIGNED' | 'COMPANY';

export interface ContextRef {
  assignmentId: string;
  role: string;
  scope: ScopeKind;
}

/** A pending approval task assigned to this identity (it may decide it once). */
export interface DecisionItem {
  taskId: string;
  kind: 'leave_request';
  requestId: string;
  /** Manifest index of the requester. */
  ownerIndex: number;
}

/** An own leave request in RETURNED state: the owner may amend and resubmit it. */
export interface ResubmitItem {
  requestId: string;
  expectedVersion: number;
}

/** An own SUBMITTED leave request reserved for withdrawal by its owner (never in anyone's decision inventory). */
export interface WithdrawItem {
  requestId: string;
}

/** An own attendance day the owner may ask to correct to PRESENT (one open correction per day). */
export interface CorrectionItem {
  attendanceRecordId: string;
  workDate: string;
  currentStatus: string;
}

export interface FixtureIdentity {
  index: number;
  accountKey: string;
  userId: string;
  companyId: string;
  companyIndex: number;
  companyTier: CompanyTier;
  /** Role of the primary context (the G2 role distribution counts this). */
  role: string;
  employeeId: string;
  employeeCode: string;
  managerEmployeeId: string | null;
  departmentId: string;
  /** primary: the role context; own: the Employee OWN context for own ESS work (the same assignment for Employees). */
  contexts: { primary: ContextRef; own: ContextRef };
  /** Context headers of the primary context, exactly as a client sends them. */
  headers: { 'x-hrms-company': string; 'x-hrms-assignment': string };
  session: { id: string; expiresAt: string; token: string };
  /** Workflow states this identity can act on; a run consumes them (restore the database snapshot before reuse). */
  workflow: { decide: DecisionItem[]; resubmit: ResubmitItem[]; withdraw: WithdrawItem[]; correct: CorrectionItem[]; reports: string[] };
  /** Direct reports (employee ids), for team reads by Reporting Managers. */
  team: string[];
  /** Leave balance available per type when the fixture was written, and the first date no fixture request uses. */
  leave: { available: Record<string, string>; nextFreeDate: string };
  attendance: { from: string | null; to: string | null; days: number };
  /** Tokens of a revoked and of a server-side expired session of this same identity (negative probes). */
  deadSessions?: { revokedToken: string; expiredToken: string };
}

export interface FixtureParameters {
  companies: number;
  identities: number;
  seed: number;
  coverAllRoles: boolean;
  attendanceDays: number;
  punches: boolean;
  absentShare: number;
  halfDayShare: number;
  pendingLeavePerIdentity: number;
  /** Mean RETURNED requests per identity (0.2: one for a fifth of identities; 2.5: two each, a third for half). */
  returnedPerIdentity: number;
  /** Mean SUBMITTED requests per identity reserved for the owner's own withdrawal (same rule). */
  withdrawPerIdentity: number;
  approvedHistoryPerIdentity: number;
  reportsPerHr: number;
  deadSessionShare: number;
  sessionHours: number;
  openingBalances: Record<string, string>;
  batchSize: number;
  concurrency: number;
}

export interface ManifestCompany {
  index: number;
  id: string;
  code: string;
  tier: CompanyTier;
  targetShare: number;
  identities: number;
  roles: Record<string, number>;
}

export interface FixtureManifest {
  schema: typeof MANIFEST_SCHEMA;
  fixtureId: string;
  createdAt: string;
  rotatedAt: string | null;
  /** Where the fixture was written (never a password). */
  database: { host: string | null; port: string | null; database: string | null };
  /** The API under test must verify tokens with this issuer/audience and the same secret (the secret is not stored). */
  token: { issuer: string; audience: string; sessionHours: number; expiresAt: string };
  businessDate: string;
  parameters: FixtureParameters;
  companies: ManifestCompany[];
  roleTotals: Record<string, number>;
  roleTargetShares: Record<string, number>;
  /** Rows actually present for the fixture's companies and users, counted after generation. */
  counts: Record<string, number>;
  inventory: { decide: number; resubmit: number; withdraw: number; correct: number; reports: number; deadSessions: number };
  schemaMigrations: string[];
  /** sha256 over every applied migration's file name and checksum (schema_migration): the exact schema revision. */
  schemaFingerprint: string;
  warnings: string[];
  identitiesFile: string;
  identityCount: number;
}

export interface LoadedFixture {
  manifest: FixtureManifest;
  /** The identities of the requested shard (all when unsharded). */
  identities: FixtureIdentity[];
}

/** Short, non-reversible fingerprint of a token for reports and identity checks (never log the token itself). */
export function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

export async function writeManifest(dir: string, manifest: FixtureManifest, identities: Iterable<FixtureIdentity>): Promise<void> {
  await mkdir(dir, { recursive: true });
  const out = createWriteStream(join(dir, manifest.identitiesFile), { encoding: 'utf8' });
  for (const identity of identities) {
    if (!out.write(`${JSON.stringify(identity)}\n`)) await once(out, 'drain');
  }
  out.end();
  await once(out, 'finish');
  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

/**
 * Reads a manifest, keeping only identities with index % count === shard.index, so each distributed generator
 * holds a disjoint set of identities (no two generators ever act as the same person).
 */
export async function readManifest(dir: string, shard: { index: number; count: number } = { index: 0, count: 1 }): Promise<LoadedFixture> {
  if (!Number.isInteger(shard.count) || shard.count < 1 || !Number.isInteger(shard.index) || shard.index < 0 || shard.index >= shard.count) {
    throw new Error(`Invalid shard ${shard.index}/${shard.count}`);
  }
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as FixtureManifest;
  if (manifest.schema !== MANIFEST_SCHEMA) throw new Error(`Unsupported manifest schema ${String(manifest.schema)}`);
  const identities: FixtureIdentity[] = [];
  const lines = createInterface({ input: createReadStream(join(dir, manifest.identitiesFile), { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const identity = JSON.parse(line) as FixtureIdentity;
    if (identity.index % shard.count === shard.index) identities.push(identity);
  }
  return { manifest, identities };
}
