// Smoke test of the workload harness MECHANICS (BRD v8.2 G4). It starts an embedded PostgreSQL through the shared
// test harness, builds the real app in-process (bound to an ephemeral 127.0.0.1 port), writes a tiny G2 fixture,
// runs the open-loop generator for about 3 seconds at 5 requests/second and checks how the harness behaves.
// It asserts no capacity number and no latency threshold: a tiny local run proves only that the harness works (G5).
// Run: npx vitest run load/
import type { IncomingMessage } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, startHarness, tokenConfig } from '../apps/api/src/test/harness.js';
import { generateFixture } from './fixtures.js';
import {
  ArrivalSchedule,
  assessGeneratorHealth,
  consumedKeys,
  DEFAULT_HEALTH_THRESHOLDS,
  holdSpan,
  mergeReports,
  missingReportFields,
  planRun,
  PROFILES,
  runLoad,
  stageHold,
  sweepWorkload,
} from './generator.js';
import type { GeneratorMeasurements } from './lib/health.js';
import { LogHistogram } from './lib/histogram.js';
import { type FixtureIdentity, type LoadedFixture, readManifest, tokenFingerprint } from './lib/manifest.js';
import { companyShares, planFixture, ROLE_CODES, roleTargetShares } from './lib/plan.js';
import { buildReport, Collector, generatorEntry, type IdentityMeta, type RequestRecord, type RunContext } from './lib/report.js';
import { createRng } from './lib/rng.js';
import { CATEGORIES, IdentityPool, MixSelector } from './lib/workload.js';

let h: Harness;
let base: string;
let dir: string;
let fixture: LoadedFixture;
/** What the server actually received for every load request, keyed by its x-request-id. */
const seen = new Map<string, { authorization: string; company: string | undefined; assignment: string | undefined }>();
const consumed = new Set<string>();

const header = (req: IncomingMessage, name: string) => {
  const v = req.headers[name];
  return typeof v === 'string' ? v : undefined;
};

beforeAll(async () => {
  h = await startHarness();
  // Raw server listener: sees every request, including the ones the app rejects before any route runs.
  h.app.server.on('request', (req: IncomingMessage) => {
    const id = header(req, 'x-request-id');
    if (id?.startsWith('lt')) seen.set(id, { authorization: header(req, 'authorization') ?? '', company: header(req, 'x-hrms-company'), assignment: header(req, 'x-hrms-assignment') });
  });
  await h.app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
  dir = await mkdtemp(join(tmpdir(), 'hrms-load-'));
  await generateFixture({ db: h.pool, token: tokenConfig, outDir: dir, companies: 2, identities: 50, seed: 7, concurrency: 2 });
  fixture = await readManifest(dir);
}, 180_000);

afterAll(async () => {
  await h?.stop();
  if (dir) await rm(dir, { recursive: true, force: true });
});

const byIndex = () => new Map(fixture.identities.map((x) => [x.index, x]));
const tokenOf = (x: FixtureIdentity, kind: RequestRecord['token']) =>
  kind === 'revoked' ? x.deadSessions!.revokedToken : kind === 'expired' ? x.deadSessions!.expiredToken : x.session.token;

/** Server-side check that every request carried its own identity's token and context headers. */
function expectOwnHeaders(records: RequestRecord[]) {
  const identities = byIndex();
  for (const r of records) {
    if (r.dispatchedAtMs === null) continue;
    const x = identities.get(r.identityIndex)!;
    const got = seen.get(r.requestId);
    expect(got, `request ${r.requestId} never reached the server`).toBeDefined();
    const expectedToken = tokenOf(x, r.token);
    expect(tokenFingerprint(got!.authorization.replace(/^Bearer /, ''))).toBe(tokenFingerprint(expectedToken));
    expect(r.tokenFingerprint).toBe(tokenFingerprint(expectedToken));
    expect(got!.company).toBe(x.companyId);
    expect(got!.assignment).toBe(r.context === 'primary' ? x.contexts.primary.assignmentId : r.context === 'own' ? x.contexts.own.assignmentId : undefined);
  }
}

const goodMeasurements: GeneratorMeasurements = {
  sent: 1000,
  lateSends: 0,
  lateness: { count: 1000, p50: 1, p95: 2, p99: 3, max: 5, mean: 1 },
  dispatchLag: { count: 1000, p50: 0, p95: 1, p99: 1, max: 2, mean: 0 },
  droppedByGenerator: 0,
  inFlightMax: 10,
  maxInFlight: 1000,
  preflight: { ok: true, detail: 'ok' },
  eventLoopLagMs: { p50: 1, p99: 5, max: 10, mean: 1, samples: 100, resolutionMs: 10 },
  eventLoopUtilisation: 0.1,
  cpu: { userMs: 100, systemMs: 10, wallMs: 1000, utilisation: 0.11, cores: 4 },
  memory: { rssMaxMb: 100, heapUsedMaxMb: 50, heapLimitMb: 4000, heapFractionMax: 0.01, systemTotalMb: 16000, systemFreeMinMb: 8000 },
};

describe('fixture (G2 shape, distinct identities, valid workflow states)', () => {
  it('writes a manifest of distinct identities with their own sessions, tokens and context headers', () => {
    const { manifest, identities } = fixture;
    expect(manifest.identityCount).toBe(50);
    expect(identities).toHaveLength(50);
    // G2 skew scaled to two companies: the hot company first and much larger.
    expect(manifest.companies.map((c) => c.tier)).toEqual(['HOT', 'LARGE']);
    expect(manifest.companies[0]!.identities).toBeGreaterThan(manifest.companies[1]!.identities * 3);
    expect(manifest.companies.reduce((n, c) => n + c.identities, 0)).toBe(50);
    // Every one of the 14 baseline roles has an identity; the counts match the identities written.
    for (const code of ROLE_CODES) expect(manifest.roleTotals[code], code).toBeGreaterThanOrEqual(1);
    for (const code of ROLE_CODES) expect(identities.filter((x) => x.role === code)).toHaveLength(manifest.roleTotals[code]!);
    // Distinct people: users, employees, accounts, sessions, tokens and role contexts are never shared.
    const picks: ((x: FixtureIdentity) => string)[] = [
      (x) => x.userId,
      (x) => x.employeeId,
      (x) => x.accountKey,
      (x) => x.session.id,
      (x) => x.session.token,
      (x) => x.contexts.primary.assignmentId,
    ];
    for (const pick of picks) expect(new Set(identities.map(pick)).size).toBe(50);
    for (const x of identities) {
      expect(x.headers).toEqual({ 'x-hrms-company': x.companyId, 'x-hrms-assignment': x.contexts.primary.assignmentId });
      expect(x.contexts.own.role).toBe('EMPLOYEE');
      expect(x.contexts.own.scope).toBe('OWN');
      expect(Date.parse(x.session.expiresAt)).toBeGreaterThan(Date.now());
    }
    expect(manifest.token).toMatchObject({ issuer: tokenConfig.issuer, audience: tokenConfig.audience });
    expect(JSON.stringify(manifest)).not.toContain(tokenConfig.secret);
    expect(manifest.schemaMigrations.length).toBeGreaterThan(0);
    expect(manifest.schemaFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reports the actual row counts, and the workflow inventory is in valid states decided by distinct actors', () => {
    const { manifest, identities } = fixture;
    const c = manifest.counts;
    expect(c.companies).toBe(2);
    expect(c.employees).toBe(50);
    expect(c.userEmployeeLinks).toBe(50);
    expect(c.managerAssignments).toBe(48); // every identity but the two top managers reports to someone
    expect(c.attendanceRecords).toBe(50 * manifest.parameters.attendanceDays);
    expect(c.sessions).toBe(50 + 2 * manifest.inventory.deadSessions);
    expect(c.sessionsLive).toBe(50); // the revoked and server-expired probe sessions are not live
    expect(c.leaveRequestsSubmitted).toBe(manifest.inventory.decide + manifest.inventory.withdraw);
    expect(c.leaveRequestsReturned).toBe(manifest.inventory.resubmit);
    expect(c.approvalTasksPending).toBe(c.leaveRequestsSubmitted);
    expect(c.leaveRequestsApproved).toBeGreaterThan(0);
    expect(c.reportExecutions).toBe(manifest.roleTotals.HR_ADMINISTRATOR);
    expect(manifest.inventory.decide).toBeGreaterThanOrEqual(45);
    expect(manifest.inventory.deadSessions).toBeGreaterThan(0);
    expect(manifest.inventory.correct).toBe(identities.reduce((n, x) => n + x.workflow.correct.length, 0));
    const owners = byIndex();
    for (const reviewer of identities) {
      for (const d of reviewer.workflow.decide) {
        const owner = owners.get(d.ownerIndex)!;
        expect(owner.userId).not.toBe(reviewer.userId);
        expect(owner.companyId).toBe(reviewer.companyId);
      }
    }
  });
});

describe('open-loop generator against the in-process API', () => {
  let report: Awaited<ReturnType<typeof runLoad>>['report'];
  let records: RequestRecord[];
  let summary: string;

  beforeAll(async () => {
    ({ report, records, summary } = await runLoad({
      target: base,
      fixture,
      phases: [{ ratePerSecond: 5, durationSeconds: 3 }],
      arrival: 'uniform',
      negativeShare: 0.2,
      keepRecords: true,
      seed: 3,
    }));
    for (const k of consumedKeys(records)) consumed.add(k);
  }, 60_000);

  it('produces a report with every field and a text summary', () => {
    expect(missingReportFields(report)).toEqual([]);
    expect(summary).toContain('Run verdict');
    expect(summary).toContain('No capacity claim');
    expect(report.latency.basis).toBe('scheduled-time');
    expect(report.totals.offered).toBe(15);
    expect(records).toHaveLength(15);
  });

  it('schedules arrivals open-loop, independent of responses', () => {
    const scheduled = records.map((r) => r.scheduledAtMs).sort((a, b) => a - b);
    scheduled.forEach((t, k) => expect(t).toBeCloseTo(k * 200, 6));
    expect(report.totals.sent).toBe(15);
    expect(report.totals.notSent).toBe(0);
    // Offered, sent and completed are counted separately; sends and completions after the window are reported.
    expect(report.rates.offeredPerSecond).toBe(5);
    expect(report.rates.sentPerSecond * 3 + report.rates.sentAfterWindow).toBeCloseTo(15, 2);
    expect(report.rates.completedPerSecond * 3 + report.rates.completedAfterWindow).toBeCloseTo(report.totals.completed, 2);
  });

  it('measures latency from the scheduled time, not from the send time', () => {
    for (const r of records) {
      expect(r.completedAtMs).not.toBeNull();
      expect(r.dispatchedAtMs!).toBeGreaterThanOrEqual(r.scheduledAtMs);
      expect(r.sentAtMs!).toBeGreaterThanOrEqual(r.dispatchedAtMs!);
      expect(r.completedAtMs!).toBeGreaterThanOrEqual(r.sentAtMs!);
      expect(r.latencyMs!).toBeCloseTo(r.completedAtMs! - r.scheduledAtMs, 9);
      expect(r.latencyMs!).toBeGreaterThanOrEqual(r.serviceMs!);
    }
  });

  it('respects the G2 operation mix within one request per category', () => {
    for (const c of CATEGORIES) {
      expect(Math.abs((report.mix.offeredByCategory[c] ?? 0) - 15 * PROFILES.nominal[c]), c).toBeLessThanOrEqual(1);
    }
    expect(report.mix.unplannable).toEqual({});
  });

  it('issues every request as a distinct fixture identity with its own token and headers', () => {
    expectOwnHeaders(records);
    expect(report.identities.distinctUsed).toBeGreaterThanOrEqual(12);
    expect(report.identities.maxRequestsPerIdentity).toBeLessThanOrEqual(2);
  });

  it('gets valid scripted requests accepted and negative probes denied', () => {
    const failed = records.filter((r) => r.probe === null && r.outcome !== 'OK').map((r) => `${r.op} ${r.status} ${r.errorCode}`);
    expect(failed).toEqual([]);
    expect(report.negative.planned).toBe(3);
    expect(records.filter((r) => r.probe !== null).every((r) => r.outcome === 'DENIED_AS_EXPECTED')).toBe(true);
    expect(Object.values(report.negative.deniedByCode).reduce((t, v) => t + v, 0)).toBe(3);
    expect(report.totals.integrityFailures).toBe(0);
    // The S03 error budget is taken over valid requests only (negative probes are expected refusals).
    expect(report.totals.validOffered).toBe(12);
    expect(report.totals.s03FailureRate).toBe(0);
  });

  it('keeps cohorts by role, company tier and region, and counts positive and negative requests per role', () => {
    const positive = records.filter((r) => r.probe === null);
    const roles = new Set(positive.map((r) => byIndex().get(r.identityIndex)!.role));
    expect(Object.keys(report.latency.byRole).sort()).toEqual([...roles].sort());
    expect(Object.values(report.latency.byRole).reduce((t, s) => t + s.count, 0)).toBe(positive.length);
    expect(Object.values(report.latency.byTier).reduce((t, s) => t + s.count, 0)).toBe(positive.length);
    expect(Object.keys(report.latency.byRegion)).toEqual(['unlabelled']);
    const byRole = Object.values(report.identities.byRole);
    expect(byRole.reduce((t, c) => t + c.positive, 0)).toBe(12);
    expect(byRole.reduce((t, c) => t + c.negative, 0)).toBe(3);
    expect(report.identities.roleCoverage.roles).toEqual([...ROLE_CODES].sort());
  });

  it('keeps the G4/G5 rules: a harness check is never stage or gate evidence', () => {
    expect(['PASS', 'FAIL', 'BLOCKED']).toContain(report.verdict.run);
    if (!report.generator.healthy) expect(report.verdict.run).toBe('BLOCKED');
    expect(report.generator.healthy).toBe(report.generator.reasons.length === 0);
    expect(report.verdict.stage.verdict).toBe('BLOCKED');
    expect(report.verdict.gates.map((g) => g.id)).toEqual(['ZT31', 'ZT32', 'ZT33', 'ZT34', 'ZT35']);
    expect(report.verdict.gates.every((g) => g.verdict !== 'PASS')).toBe(true);
    expect(report.verdict.claim).toMatch(/^No capacity claim/);
  });
});

describe('route sweep (one request per operation and negative probe)', () => {
  it('gets every scripted operation accepted and every probe kind denied, each as its own fixture identity', async () => {
    const sweep = await sweepWorkload({ target: base, fixture, consumed, paceMs: 100 });
    for (const k of consumedKeys(sweep.records)) consumed.add(k);
    expect(sweep.problems).toEqual([]);
    expect(sweep.ok).toBe(true);
    expect(sweep.integrityFailures).toBe(0);
    expect(sweep.uncovered).toEqual([]);
    expect(new Set(sweep.rows.map((r) => r.op)).size).toBe(sweep.rows.length);
    expect(sweep.rows.filter((r) => r.probe === null)).toHaveLength(24);
    expect(sweep.rows.filter((r) => r.probe !== null)).toHaveLength(9);
    // Every baseline role has a negative probe kind in its own role context.
    expect(sweep.rows.find((r) => r.op === 'probe:no-task-permission')?.outcome).toBe('DENIED_AS_EXPECTED');
    expectOwnHeaders(sweep.records);
  }, 60_000);
});

describe('generator health', () => {
  it('blocks a run whose generator falls behind its schedule, and still counts latency from the schedule', async () => {
    const busy = (ms: number) => {
      const end = performance.now() + ms;
      while (performance.now() < end) {
        // Simulates a saturated generator: the event loop is blocked before each send.
      }
    };
    const { report, records } = await runLoad({
      target: base,
      fixture,
      phases: [{ ratePerSecond: 10, durationSeconds: 1 }],
      arrival: 'uniform',
      negativeShare: 0,
      keepRecords: true,
      seed: 5,
      preflight: false,
      consumed,
      leaveDateFrom: '2028-01-03',
      hooks: { beforeDispatch: () => busy(150) },
    });
    for (const k of consumedKeys(records)) consumed.add(k);
    expect(report.totals.offered).toBe(10);
    expect(report.totals.sent).toBe(10); // open loop: late arrivals are sent late, never skipped
    expect(report.generator.healthy).toBe(false);
    expect(report.generator.reasons.join(' ')).toMatch(/behind its schedule/);
    expect(report.verdict.run).toBe('BLOCKED');
    // The lag shows in the rates too: part of the schedule was only sent after its window.
    expect(report.rates.sentAfterWindow).toBeGreaterThan(0);
    expect(report.rates.sentPerSecond).toBeLessThan(report.rates.offeredPerSecond);
    const late = records.filter((r) => r.sentAtMs! - r.scheduledAtMs > 100);
    expect(late.length).toBeGreaterThan(5);
    for (const r of late) expect(r.latencyMs! - r.serviceMs!).toBeCloseTo(r.sentAtMs! - r.scheduledAtMs, 6);
    expectOwnHeaders(records);
  }, 60_000);

  it('applies the health rules to measurements', () => {
    expect(assessGeneratorHealth(goodMeasurements)).toEqual({ healthy: true, reasons: [] });
    const bad = (patch: Partial<GeneratorMeasurements>) => assessGeneratorHealth({ ...goodMeasurements, ...patch }, DEFAULT_HEALTH_THRESHOLDS);
    expect(bad({ lateSends: 20 }).healthy).toBe(false);
    expect(bad({ droppedByGenerator: 1 }).reasons.join()).toMatch(/dropped/);
    expect(bad({ eventLoopLagMs: { ...goodMeasurements.eventLoopLagMs, p99: 250 } }).healthy).toBe(false);
    expect(bad({ eventLoopUtilisation: 0.97 }).reasons.join()).toMatch(/event loop busy/);
    expect(bad({ cpu: { ...goodMeasurements.cpu, utilisation: 0.97 } }).healthy).toBe(false);
    expect(bad({ memory: { ...goodMeasurements.memory, heapFractionMax: 0.9 } }).healthy).toBe(false);
    expect(bad({ preflight: { ok: false, detail: 'SESSION_IDLE' } }).reasons.join()).toMatch(/preflight/);
  });
});

describe('distributed generators', () => {
  it('shards identities disjointly and merges shard reports into one run with region cohorts', async () => {
    const shards = await Promise.all([0, 1].map((index) => readManifest(dir, { index, count: 2 })));
    const [a, b] = shards.map((s) => new Set(s.identities.map((x) => x.index)));
    expect(a!.size + b!.size).toBe(50);
    expect([...a!].some((i) => b!.has(i))).toBe(false);
    // A common start leaves time for each shard's session preflight first.
    const startAt = Date.now() + 1500;
    const runs = await Promise.all(
      shards.map((s, index) =>
        runLoad({
          target: base,
          fixture: s,
          phases: [{ ratePerSecond: 3, durationSeconds: 1 }],
          arrival: 'uniform',
          shard: { index, count: 2 },
          startAt,
          generatorId: `smoke-${index}`,
          region: index === 0 ? 'smoke-a' : 'smoke-b',
          keepRecords: true,
          seed: 11,
          consumed,
          leaveDateFrom: '2029-01-01',
        }),
      ),
    );
    for (const r of runs) {
      expect(r.report.verdict.stage.verdict).toBe('BLOCKED');
      expectOwnHeaders(r.records);
      for (const k of consumedKeys(r.records)) consumed.add(k);
    }
    const merged = mergeReports(runs.map((r) => r.report));
    expect(missingReportFields(merged)).toEqual([]);
    expect(merged.run.merged).toBe(true);
    expect(merged.run.phases).toEqual([{ ratePerSecond: 6, durationSeconds: 1 }]);
    expect(merged.totals.offered).toBe(runs[0]!.report.totals.offered + runs[1]!.report.totals.offered);
    expect(merged.identities.available).toBe(50);
    expect(merged.generator.perGenerator.map((g) => g.generatorId).sort()).toEqual(['smoke-0', 'smoke-1']);
    // S03 is checked per region as well as overall once more than one region reports.
    expect(Object.keys(merged.latency.byRegion)).toEqual(['smoke-a', 'smoke-b']);
    expect(merged.s03.checks.some((c) => c.name.endsWith('(region smoke-a)'))).toBe(true);
    expect(merged.verdict.stage.verdict).toBe('BLOCKED');
    expect(() => mergeReports([runs[0]!.report, runs[0]!.report])).toThrow(/appears twice/);
  }, 60_000);

  it('sizes a schedule against the fixture inventory without sending anything', () => {
    const tiny = planRun(fixture, [{ ratePerSecond: 5, durationSeconds: 3 }]);
    expect(tiny.sufficient).toBe(true);
    expect(tiny.uncovered).toEqual([]);
    const stageLength = planRun(fixture, [{ ratePerSecond: 1000, durationSeconds: 7200 }]);
    expect(stageLength.sufficient).toBe(false);
    expect(stageLength.inventory.find((i) => i.op === 'leave-decide')!.expected).toBeGreaterThan(stageLength.inventory.find((i) => i.op === 'leave-decide')!.available);
  });
});

describe('pure mechanics (no database)', () => {
  it('sizes companies and roles with the G2 skew and distribution at representative scale', () => {
    const shares = companyShares(10_000);
    expect(shares[0]!.share).toBeCloseTo(0.1, 12);
    for (const s of shares.slice(1, 10)) expect(s.share).toBeCloseTo(0.02, 12);
    expect(shares.slice(10).reduce((t, s) => t + s.share, 0)).toBeCloseTo(0.72, 9);
    const small = companyShares(2);
    expect(small[0]!.share).toBeGreaterThan(small[1]!.share);
    expect(small[0]!.share + small[1]!.share).toBeCloseTo(1, 12);
    const plan = planFixture(100_000, 100);
    expect(plan.companies[0]!.identities).toBe(10_000);
    expect(plan.companies.slice(1, 10).every((c) => c.identities === 2_000)).toBe(true);
    const targets = roleTargetShares();
    for (const code of ROLE_CODES) expect(Math.abs(plan.roleTotals[code]! / 100_000 - targets[code]!), code).toBeLessThan(0.0005);
    expect(plan.warnings).toEqual([]);
  });

  it('schedules uniform and Poisson arrivals over the period', () => {
    const uniform = new ArrivalSchedule([{ ratePerSecond: 5, durationSeconds: 3 }], 'uniform', createRng(1));
    const times: number[] = [];
    for (let a = uniform.next(); a; a = uniform.next()) times.push(a.atMs);
    expect(times).toEqual(Array.from({ length: 15 }, (_, k) => k * 200));
    const poisson = new ArrivalSchedule(
      [
        { ratePerSecond: 1000, durationSeconds: 5 },
        { ratePerSecond: 2000, durationSeconds: 5 },
      ],
      'poisson',
      createRng(2),
    );
    const perPhase = [0, 0];
    let last = -1;
    for (let a = poisson.next(); a; a = poisson.next()) {
      expect(a.atMs).toBeGreaterThan(last);
      last = a.atMs;
      perPhase[a.phase]! += 1;
    }
    expect(Math.abs(perPhase[0]! - 5000)).toBeLessThan(400);
    expect(Math.abs(perPhase[1]! - 10000)).toBeLessThan(600);
    expect(last).toBeLessThan(10_000);
  });

  it('keeps the deterministic mix exact over long sequences and the write-heavy profile at 50% writes', () => {
    const mix = new MixSelector(PROFILES.nominal);
    const counts: Record<string, number> = {};
    for (let i = 0; i < 10_000; i++) {
      const k = mix.next()!.key;
      counts[k] = (counts[k] ?? 0) + 1;
    }
    for (const c of CATEGORIES) expect(Math.abs(counts[c]! - 10_000 * PROFILES.nominal[c])).toBeLessThanOrEqual(1);
    for (const p of Object.values(PROFILES)) expect(Object.values(p).reduce((t, v) => t + v, 0)).toBeCloseTo(1, 12);
    expect(PROFILES['write-heavy'].write).toBe(0.5);
    expect(PROFILES['write-heavy'].scopedRead / PROFILES['write-heavy'].ownRead).toBeCloseTo(2.5, 9);
  });

  it('spreads requests over identities least-recently-used first', () => {
    const lastUsed = new Float64Array(10).fill(-1);
    const pool = new IdentityPool([...Array(10).keys()], lastUsed);
    const used: number[] = [];
    for (let seq = 0; seq < 20; seq++) {
      const id = pool.pick()!;
      lastUsed[id] = seq;
      used.push(id);
    }
    expect(new Set(used.slice(0, 10)).size).toBe(10);
    for (let i = 0; i < 10; i++) expect(used.filter((u) => u === i)).toHaveLength(2);
    pool.remove(3);
    for (let i = 0; i < 9; i++) expect(pool.pick()).not.toBe(3);
  });

  it('keeps percentiles within 1% and merges histograms exactly', () => {
    const all = new LogHistogram();
    const lo = new LogHistogram();
    const hi = new LogHistogram();
    for (let v = 1; v <= 1000; v++) {
      all.record(v);
      (v <= 500 ? lo : hi).record(v);
    }
    expect(Math.abs(all.percentile(0.5)! - 500) / 500).toBeLessThan(0.011);
    expect(Math.abs(all.percentile(0.99)! - 990) / 990).toBeLessThan(0.011);
    expect(LogHistogram.from(lo.toJSON()).merge(hi.toJSON()).toJSON()).toEqual(all.toJSON());
  });

  it('takes the S03 error budget over valid requests, counts dropped arrivals as failures and rates inside the window', () => {
    const ids: IdentityMeta[] = [
      { index: 0, role: 'EMPLOYEE', tier: 'HOT', companyId: 'c1' },
      { index: 1, role: 'REPORTING_MANAGER', tier: 'HOT', companyId: 'c1' },
    ];
    const rec = (seq: number, patch: Partial<RequestRecord>): RequestRecord => ({
      seq,
      requestId: `lt-synthetic-${seq}`,
      phase: 0,
      category: 'scopedRead',
      op: 'dashboard',
      kind: 'read',
      probe: null,
      identityIndex: seq % 2,
      context: 'primary',
      token: 'live',
      tokenFingerprint: null,
      companyHeader: 'c1',
      assignmentHeader: null,
      method: 'GET',
      path: '/v1/dashboard',
      scheduledAtMs: seq * 80,
      dispatchedAtMs: seq * 80,
      sentAtMs: seq * 80 + 1,
      completedAtMs: seq * 80 + 20,
      latencyMs: 20,
      serviceMs: 19,
      status: 200,
      errorCode: null,
      outcome: 'OK',
      inventoryKey: null,
      ...patch,
    });
    const records = [
      ...Array.from({ length: 8 }, (_, k) => rec(k, {})),
      // Sent late (after the 1 s window) and completed after it.
      rec(8, { scheduledAtMs: 800, dispatchedAtMs: 1190, sentAtMs: 1200, completedAtMs: 1300, latencyMs: 500, serviceMs: 100 }),
      // Dropped at the generator's in-flight limit: a failure without a latency.
      rec(9, { dispatchedAtMs: null, sentAtMs: null, completedAtMs: null, latencyMs: null, serviceMs: null, status: null, errorCode: 'GENERATOR_IN_FLIGHT_LIMIT', outcome: 'NOT_SENT' }),
      rec(10, { probe: 'no-permission', op: 'probe:no-permission', identityIndex: 0, status: 403, errorCode: 'FORBIDDEN', outcome: 'DENIED_AS_EXPECTED' }),
      rec(11, { probe: 'no-permission', op: 'probe:no-permission', identityIndex: 0, status: 500, errorCode: 'INTERNAL', outcome: 'SERVER_ERROR' }),
    ];
    const collector = new Collector(ids, 1, 50, 1000, 'test-region');
    for (const r of records) collector.add(r, r.identityIndex);
    const entry = generatorEntry({ generatorId: 'g', region: 'test-region', shard: { index: 0, count: 1 }, startEpochMs: 0 }, goodMeasurements, DEFAULT_HEALTH_THRESHOLDS);
    const raw = collector.finish({ offeredByCategory: { scopedRead: 12 }, offeredByOperation: {}, notCovered: {}, inventoryExhausted: {}, unplannable: {}, probesPlanned: 2 }, [entry]);
    const ctx = (stage: RunContext['stage']): RunContext => ({
      runId: 'synthetic',
      stage,
      profile: 'nominal',
      profileShares: PROFILES.nominal,
      arrival: 'uniform',
      mixSelection: 'deficit',
      seed: 1,
      phases: [{ ratePerSecond: 12, durationSeconds: 1 }],
      timeoutMs: 1000,
      maxInFlight: 10,
      negativeShare: 0.2,
      target: 'synthetic',
      startedAt: '2026-01-01T00:00:00.000Z',
      startEpochMs: 0,
      finishedAt: '2026-01-01T00:00:02.000Z',
      drainSeconds: 0.3,
      labels: { build: null, topology: null, notes: null },
      shardCount: 1,
      merged: false,
      mergedFrom: ['g'],
      records: { kept: 0, truncated: false, file: null },
      fixture: {
        fixtureId: 'SYN',
        createdAt: '2026-01-01T00:00:00.000Z',
        rotatedAt: null,
        businessDate: '2026-01-01',
        identitiesInFixture: 2,
        companies: 1,
        companySkew: [],
        roleTotals: {},
        roleTargetShares: {},
        counts: {},
        inventory: { decide: 0, resubmit: 0, withdraw: 0, correct: 0, reports: 0, deadSessions: 0 },
        schemaMigrations: [],
        schemaFingerprint: '0'.repeat(64),
        warnings: [],
      },
      inventoryCheck: [],
    });
    const report = buildReport(raw, ctx('harness-check'));
    expect(missingReportFields(report)).toEqual([]);
    expect(report.totals.offered).toBe(12);
    expect(report.totals.validOffered).toBe(10);
    expect(report.totals.serverErrors5xx).toBe(1); // still reported, but a probe is not a valid request
    expect(report.totals.s03Failures).toBe(1); // the dropped arrival
    expect(report.totals.s03FailureRate).toBeCloseTo(0.1, 12);
    expect(report.rates).toMatchObject({ offeredPerSecond: 12, sentPerSecond: 10, sentAfterWindow: 1, completedPerSecond: 10, completedAfterWindow: 1 });
    expect(report.negative.deniedByCode).toEqual({ FORBIDDEN: 1 });
    expect(report.identities.roleCoverage).toEqual({ roles: ['EMPLOYEE', 'REPORTING_MANAGER'], withoutPositive: [], withoutNegative: ['REPORTING_MANAGER'] });
    expect(report.latency.byRole.EMPLOYEE!.count + report.latency.byRole.REPORTING_MANAGER!.count).toBe(9);
    expect(Object.keys(report.latency.byRegion)).toEqual(['test-region']);
    expect(report.verdict.run).toBe('FAIL'); // 10% unexpected failures against a 0.05% budget
    // A stage that the run never reached is BLOCKED with its shortfalls named, even when S03 also failed.
    const stage = buildReport(raw, ctx('10k')).verdict.stage;
    expect(stage.verdict).toBe('BLOCKED');
    expect(stage.reasons.join(' ')).toMatch(/distinct identities 2 < 10000.*roles without negative requests: REPORTING_MANAGER/);
    // G4 fixes the full-scale holds: a shorter declared hold is ignored, so a short run cannot reach a 10m stage PASS.
    const shortened = buildReport(raw, { ...ctx('10m'), stageHoldSeconds: 60 }).verdict.stage;
    expect(shortened.required.holdSeconds).toBe(7_200);
    expect(shortened.reasons.join(' ')).toMatch(/declared hold 60 s ignored/);
  });

  it('judges a stage on its hold: the longest run of phases at the stage rate, ramps allowed', async () => {
    expect(stageHold('10m', 60)).toEqual({ seconds: 7_200, ignoredDeclared: true });
    expect(stageHold('10m-soak', 100_000)).toEqual({ seconds: 100_000, ignoredDeclared: false });
    expect(stageHold('10k', 600)).toEqual({ seconds: 600, ignoredDeclared: false });
    // Refused before anything is sent.
    await expect(
      runLoad({ target: base, fixture, phases: [{ ratePerSecond: 1, durationSeconds: 1 }], stage: '10m-burst', stageHoldSeconds: 60, preflight: false }),
    ).rejects.toThrow(/never shorten/);
    const ramped = [
      { ratePerSecond: 500, durationSeconds: 600 },
      { ratePerSecond: 1000, durationSeconds: 3600 },
      { ratePerSecond: 1000, durationSeconds: 3600 },
      { ratePerSecond: 500, durationSeconds: 600 },
    ];
    expect(holdSpan(ramped, 999)).toEqual({ startSeconds: 600, endSeconds: 7800, phases: [1, 2] });
    expect(
      holdSpan(
        [
          { ratePerSecond: 1000, durationSeconds: 60 },
          { ratePerSecond: 500, durationSeconds: 60 },
          { ratePerSecond: 1500, durationSeconds: 120 },
        ],
        999,
      ),
    ).toEqual({ startSeconds: 120, endSeconds: 240, phases: [2] });
    expect(holdSpan([{ ratePerSecond: 10, durationSeconds: 60 }], 999)).toBeNull();
  });
});
