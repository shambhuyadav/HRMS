// Loaded only when HRMS_ACCESS_TRACE_DIR is set (vitest.config.ts). Records which permission each test really asked for and the
// answer it got, for the access matrix (db/registers, BRD line 4813): what the tests exercise, not what their names suggest. Nothing
// about a request or a person is written, and nothing changes what a test sees. Asked outside a test (a beforeAll) is not recorded.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, vi } from 'vitest';
import type { AccessDecision, AccessRequest } from '../modules/access/authorize.js';

vi.mock('../modules/access/authorize.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../modules/access/authorize.js')>();
  const dir = process.env.HRMS_ACCESS_TRACE_DIR as string;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${process.pid}.jsonl`);
  const seen = new Set<string>();

  const record = (req: AccessRequest, decision: AccessDecision) => {
    const { currentTestName: test, testPath } = expect.getState();
    if (!test || !testPath) return;
    const lines = req.fieldGroups.flatMap((fieldGroup) => {
      const refusal = decision.deniedFieldGroups.find((d) => d.fieldGroup === fieldGroup)?.reason;
      const allowed = decision.allowed && decision.allowedFieldGroups.includes(fieldGroup);
      // A refusal that says nothing about this permission (an ended assignment, a disabled user) is not a test of it.
      if (!allowed && !refusal) return [];
      const line = JSON.stringify({ file: relative(process.cwd(), testPath).replace(/\\/g, '/'), test, resource: req.resource, action: req.action, fieldGroup, outcome: allowed ? 'ALLOW' : 'DENY', reason: refusal ?? null });
      if (seen.has(line)) return [];
      seen.add(line);
      return [line];
    });
    if (lines.length) appendFileSync(file, `${lines.join('\n')}\n`);
  };

  return {
    ...actual,
    resolveAccess: async (db: Parameters<typeof actual.resolveAccess>[0], req: AccessRequest) => {
      const decision = await actual.resolveAccess(db, req);
      record(req, decision);
      return decision;
    },
  };
});
