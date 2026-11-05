// The access matrix (BRD line 4813: "Run positive and negative access tests for every delivered permission"). The list of permissions is
// the catalogue's, the roles are access/baseline.ts's. A test counts only for what it really asked: a run with HRMS_ACCESS_TRACE_DIR set
// records each permission a test put to resolveAccess and the answer. Without such a run all that is left is a name in a test file,
// which cannot tell a positive test from a negative one, and the matrix says so instead of guessing.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunEvidence, TestOutcome } from './runs.js';

export interface TraceLine {
  file: string;
  test: string;
  resource: string;
  action: string;
  fieldGroup: string;
  outcome: 'ALLOW' | 'DENY';
  reason: string | null;
}

export interface CataloguePermission {
  resource: string;
  action: string;
  fieldGroup: string;
}

export interface BaselineRoleGrants {
  code: string;
  ceiling: readonly string[];
  defaultDuties: readonly string[];
}

export type TestRef = Pick<TestOutcome, 'file' | 'name'>;
export type Basis = 'Traced' | 'Not exercised' | 'Name only' | 'None';

export interface PermissionRow {
  key: string;
  ceilingRoles: string[];
  dutyRoles: string[];
  positive: TestRef[];
  negative: TestRef[];
  /** Test files that spell the permission, which says nothing about what they prove. */
  namedInFiles: string[];
  basis: Basis;
  gap: string;
}

export interface AccessMatrix {
  traced: boolean;
  rows: PermissionRow[];
  /** Asked for by a test but absent from the migrated catalogue: a test's own synthetic permission, or a name no migration creates. */
  askedButNotCatalogued: string[];
  /** In a role's ceiling or duties but absent from the catalogue. */
  grantedButNotCatalogued: string[];
}

export function readTrace(dir: string): TraceLine[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as TraceLine));
}

const keyOf = (p: CataloguePermission) => `${p.resource}.${p.action}.${p.fieldGroup}`;

function gapOf(positive: number, negative: number): string {
  if (positive && negative) return '';
  if (positive) return 'No negative test';
  if (negative) return 'No positive test';
  return 'No positive or negative test';
}

export function buildAccessMatrix(
  permissions: readonly CataloguePermission[],
  roles: readonly BaselineRoleGrants[],
  runs: readonly RunEvidence[],
  trace: readonly TraceLine[] | null,
  testSources: ReadonlyMap<string, string>,
): AccessMatrix {
  // A test only counts if it passed in a cited run: a trace line alone says it was asked, not that the test held.
  const passed = new Set(runs.flatMap((run) => run.tests.filter((t) => t.status === 'passed').map((t) => `${t.file}\n${t.name}`)));
  const positive = new Map<string, Map<string, TestRef>>();
  const negative = new Map<string, Map<string, TestRef>>();
  const asked = new Set<string>();
  for (const line of trace ?? []) {
    const key = keyOf(line);
    asked.add(key);
    const id = `${line.file}\n${line.test}`;
    if (!passed.has(id)) continue;
    const into = line.outcome === 'ALLOW' ? positive : negative;
    if (!into.has(key)) into.set(key, new Map());
    into.get(key)!.set(id, { file: line.file, name: line.test });
  }

  const sorted = (refs: Map<string, TestRef> | undefined) => [...(refs?.values() ?? [])].sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
  const catalogued = new Set(permissions.map(keyOf));
  const spelledIn = [...testSources].map(([file, source]) => [file, new Set(source.match(/\b[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\b/g) ?? [])] as const);

  const rows = [...permissions]
    .sort((a, b) => keyOf(a).localeCompare(keyOf(b)))
    .map((permission): PermissionRow => {
      const key = keyOf(permission);
      const namedInFiles = spelledIn.filter(([, spelled]) => spelled.has(`${permission.resource}.${permission.action}`)).map(([file]) => file).sort();
      const [yes, no] = [sorted(positive.get(key)), sorted(negative.get(key))];
      const basis: Basis = trace === null ? (namedInFiles.length ? 'Name only' : 'None') : yes.length || no.length ? 'Traced' : 'Not exercised';
      return {
        key,
        ceilingRoles: roles.filter((r) => r.ceiling.includes(key)).map((r) => r.code),
        dutyRoles: roles.filter((r) => r.defaultDuties.includes(key)).map((r) => r.code),
        positive: yes,
        negative: no,
        namedInFiles,
        basis,
        gap: trace === null ? (namedInFiles.length ? 'Not traced: a name match cannot tell positive from negative' : 'Not traced, and no test file names it') : gapOf(yes.length, no.length),
      };
    });

  const granted = new Set(roles.flatMap((r) => [...r.ceiling, ...r.defaultDuties]));
  return {
    traced: trace !== null,
    rows,
    askedButNotCatalogued: [...asked].filter((k) => !catalogued.has(k)).sort(),
    grantedButNotCatalogued: [...granted].filter((k) => !catalogued.has(k)).sort(),
  };
}
