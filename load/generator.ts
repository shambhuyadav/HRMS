// Open-loop workload generator (BRD v8.2 Appendix G4). Arrivals are scheduled up front from a target rate and
// duration (or step-up phases) and each request starts at its scheduled time whatever the latency of earlier ones:
// the generator never lowers offered load when the system slows. Latency is measured from the SCHEDULED time, so a
// stalled system or generator cannot hide delay (coordinated omission). Every request is issued by a distinct
// fixture identity with its own token and context headers, picked from the G2 operation mix.
//
// If the generator itself falls behind its schedule, drops arrivals or runs short of CPU/memory/event-loop time,
// the run is BLOCKED, not passed. A tiny local run proves only that the harness works (G5). Usage: load/README.md.
//   npx tsx load/generator.ts run --target http://127.0.0.1:4100 --manifest load/out/tiny --rate 5 --duration 30
// Before a long run: `plan` sizes the fixture inventory for a schedule (nothing is sent) and `sweep` sends one
// request per operation and negative probe to show that the workload still matches the API under test.
import { randomBytes } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_HEALTH_THRESHOLDS, type GeneratorMeasurements, type HealthThresholds, startHealthMonitor } from './lib/health.js';
import { LogHistogram, type SerializedHistogram } from './lib/histogram.js';
import { type FixtureIdentity, type LoadedFixture, readManifest, tokenFingerprint } from './lib/manifest.js';
import {
  buildReport,
  Collector,
  formatSummary,
  generatorEntry,
  type LoadReport,
  mergeAggregates,
  missingReportFields,
  type Outcome,
  type Phase,
  REPORT_SCHEMA,
  type RequestRecord,
  type RunContext,
  STAGES,
  type StageName,
  stageHold,
  summarizeFixture,
  UNLABELLED_REGION,
} from './lib/report.js';
import { createRng, deriveSeed, type Rng } from './lib/rng.js';
import { httpTransport, type Transport, type TransportResult } from './lib/transport.js';
import { type Category, type ContextKind, type PlannedRequest, PROFILES, type ProfileName, WorkloadPlanner } from './lib/workload.js';

export { assessGeneratorHealth, DEFAULT_HEALTH_THRESHOLDS } from './lib/health.js';
export { holdSpan, missingReportFields, REPORT_FIELDS, stageHold } from './lib/report.js';
export { PROFILES } from './lib/workload.js';

// ---------------------------------------------------------------------------------------------------------------
// Arrival schedule (open loop)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Arrival times for a sequence of phases. 'uniform' spaces arrivals evenly (offset per shard so distributed
 * generators interleave); 'poisson' draws exponential gaps (independent users). Times never depend on responses.
 */
export class ArrivalSchedule {
  private phase = 0;
  private k = 0;
  private t = 0;
  private phaseStartMs = 0;

  constructor(
    private readonly phases: readonly Phase[],
    private readonly arrival: 'uniform' | 'poisson',
    private readonly rng: Rng,
    private readonly offsetFraction = 0,
  ) {}

  next(): { atMs: number; phase: number } | null {
    while (this.phase < this.phases.length) {
      const p = this.phases[this.phase]!;
      const durationMs = p.durationSeconds * 1000;
      if (p.ratePerSecond > 0) {
        const gap = 1000 / p.ratePerSecond;
        let at: number;
        if (this.arrival === 'uniform') at = (this.k + this.offsetFraction) * gap;
        else at = this.t += this.rng.exponential(gap);
        if (at < durationMs) {
          this.k++;
          return { atMs: this.phaseStartMs + at, phase: this.phase };
        }
      }
      this.phaseStartMs += durationMs;
      this.phase++;
      this.k = 0;
      this.t = 0;
    }
    return null;
  }

  static expectedArrivals(phases: readonly Phase[]): number {
    return phases.reduce((n, p) => n + p.ratePerSecond * p.durationSeconds, 0);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------------------------------------------

export interface RunOptions {
  /** Base URL of the API under test, or a transport (tests). */
  target: string | Transport;
  fixture: LoadedFixture;
  phases: Phase[];
  profile?: ProfileName;
  arrival?: 'uniform' | 'poisson';
  mixSelection?: 'deficit' | 'random';
  seed?: number;
  /** Per-request deadline; a timeout counts as a failure and as latency of at least this long. */
  timeoutMs?: number;
  /** Generator in-flight cap; an arrival beyond it is dropped (and the run blocked). Default: peak rate x timeout x 1.2. */
  maxInFlight?: number;
  /** Share of arrivals that are negative probes (default 0.02). */
  negativeShare?: number;
  /**
   * Fixture states consumed by earlier runs on the same fixture (inventoryKey of their records), skipped by this
   * run. Restoring the fixture database snapshot before each run is the cleaner way to repeat a run.
   */
  consumed?: ReadonlySet<string>;
  /** Earliest leave date to request (YYYY-MM-DD); move it for each repeated run on an unrestored fixture. */
  leaveDateFrom?: string;
  stage?: StageName;
  stageHoldSeconds?: number;
  shard?: { index: number; count: number };
  /** Common start (epoch ms) for distributed generators. */
  startAt?: number;
  generatorId?: string;
  region?: string;
  labels?: { build?: string; topology?: string; notes?: string };
  /** Keep every request record in memory (tests and small runs). */
  keepRecords?: boolean;
  maxKeptRecords?: number;
  /** Stream every request record to this NDJSON file. */
  recordsFile?: string;
  thresholds?: Partial<HealthThresholds>;
  /** Check a few identities' sessions before the run (default true). */
  preflight?: boolean;
  /** Test hook, called synchronously before each arrival is dispatched (used to simulate a generator falling behind). */
  hooks?: { beforeDispatch?: (seq: number) => void };
  log?: (line: string) => void;
}

export interface RunResult {
  report: LoadReport;
  records: RequestRecord[];
  summary: string;
}

function classify(p: PlannedRequest, r: TransportResult): Outcome {
  if (r.outcome === 'TIMEOUT') return 'TIMEOUT';
  if (r.outcome === 'NETWORK_ERROR') return 'NETWORK_ERROR';
  const s = r.status ?? 0;
  if (s === 429) return 'THROTTLED';
  if (s >= 500) return 'SERVER_ERROR';
  if (p.expectStatus) {
    if (p.expectStatus.includes(s)) return 'DENIED_AS_EXPECTED';
    if (s >= 200 && s < 300) return 'UNEXPECTEDLY_ALLOWED';
    return 'PROBE_WRONG_STATUS';
  }
  if (s >= 200 && s < 300) return p.validate && !p.validate(r.body) ? 'IDENTITY_MISMATCH' : 'OK';
  return 'REJECTED';
}

/** Checks that a few identities' sessions are accepted, so a stale fixture blocks the run instead of failing it. */
async function preflight(transport: Transport, identities: readonly FixtureIdentity[], runId: string, timeoutMs: number): Promise<{ ok: boolean; detail: string }> {
  const sample: FixtureIdentity[] = [];
  const companies = new Set<string>();
  for (const x of identities) {
    if (sample.length >= 3) break;
    if (companies.has(x.companyId)) continue;
    companies.add(x.companyId);
    sample.push(x);
  }
  if (sample.length === 0) return { ok: false, detail: 'the fixture shard has no identities' };
  for (const [i, x] of sample.entries()) {
    const r = await transport.send(
      {
        method: 'GET',
        path: '/v1/me/context',
        headers: { authorization: `Bearer ${x.session.token}`, 'x-hrms-company': x.companyId, 'x-hrms-assignment': x.contexts.primary.assignmentId, 'x-request-id': `${runId}-pre-${i}` },
      },
      { timeoutMs, wantBody: true, onSent: () => undefined },
    );
    const body = r.body as { userId?: unknown } | null;
    if (r.status !== 200 || body?.userId !== x.userId) {
      const hint = r.errorCode?.startsWith('SESSION_') ? ' (sessions go idle after 30 minutes: run fixtures.ts rotate-sessions)' : '';
      return { ok: false, detail: `identity #${x.index} got ${r.status ?? r.outcome} ${r.errorCode ?? ''}${hint}`.trim() };
    }
  }
  return { ok: true, detail: `${sample.length} identities accepted` };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runLoad(options: RunOptions): Promise<RunResult> {
  const phases = options.phases;
  if (phases.length === 0) throw new Error('At least one phase (rate and duration) is required');
  for (const p of phases) {
    if (!(p.ratePerSecond >= 0) || !(p.durationSeconds > 0)) throw new Error('Each phase needs a rate >= 0 and a duration > 0');
  }
  const { manifest, identities } = options.fixture;
  if (identities.length === 0) throw new Error('The fixture (shard) has no identities');
  const profile = options.profile ?? 'nominal';
  const profileShares = PROFILES[profile];
  if (!profileShares) throw new Error(`Unknown profile ${profile}`);
  const arrival = options.arrival ?? 'poisson';
  const mixSelection = options.mixSelection ?? 'deficit';
  const seed = options.seed ?? 1;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const negativeShare = options.negativeShare ?? 0.02;
  const stage = options.stage ?? 'harness-check';
  if (!STAGES[stage]) throw new Error(`Unknown stage ${stage}`);
  if (options.stageHoldSeconds !== undefined) {
    if (!(options.stageHoldSeconds > 0)) throw new Error('stageHoldSeconds must be positive');
    if (stageHold(stage, options.stageHoldSeconds).ignoredDeclared) {
      throw new Error(`G4 fixes the hold of stage ${stage} at ${STAGES[stage].holdSeconds} s: a declared hold may lengthen it, never shorten it`);
    }
  }
  const shard = options.shard ?? { index: 0, count: 1 };
  const peakRate = Math.max(...phases.map((p) => p.ratePerSecond));
  const maxInFlight = options.maxInFlight ?? Math.max(1000, Math.ceil(peakRate * (timeoutMs / 1000) * 1.2));
  const thresholds: HealthThresholds = { ...DEFAULT_HEALTH_THRESHOLDS, ...options.thresholds };
  const runId = `lt${randomBytes(4).toString('hex')}`;
  const generatorId = options.generatorId ?? `gen-${shard.index}`;
  const log = options.log ?? (() => undefined);

  if (options.leaveDateFrom !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(options.leaveDateFrom)) throw new Error('leaveDateFrom must be YYYY-MM-DD');
  const planner = new WorkloadPlanner(identities, {
    runId,
    profile: profileShares,
    negativeShare,
    seed: deriveSeed(seed, shard.index),
    mixSelection,
    businessDate: manifest.businessDate,
    ...(options.consumed ? { consumed: options.consumed } : {}),
    ...(options.leaveDateFrom ? { leaveDateFrom: options.leaveDateFrom } : {}),
  });
  const inventoryCheck = planner.inventoryCheck(Math.ceil(ArrivalSchedule.expectedArrivals(phases)));
  const schedule = new ArrivalSchedule(phases, arrival, createRng(deriveSeed(seed, 1000 + shard.index)), arrival === 'uniform' ? shard.index / shard.count : 0);
  const scheduleMs = phases.reduce((t, p) => t + p.durationSeconds * 1000, 0);
  const collector = new Collector(
    identities.map((x) => ({ index: x.index, role: x.role, tier: x.companyTier, companyId: x.companyId })),
    phases.length,
    thresholds.lateThresholdMs,
    scheduleMs,
    options.region ?? UNLABELLED_REGION,
  );
  const ownsTransport = typeof options.target === 'string';
  const transport = typeof options.target === 'string' ? httpTransport(options.target, { maxSockets: maxInFlight }) : options.target;
  const targetLabel = typeof options.target === 'string' ? sanitizeUrl(options.target) : 'in-process transport';

  const records: RequestRecord[] = [];
  const keep = options.keepRecords === true;
  // Token fingerprints are only needed in kept or streamed records (they let reviewers check identity use).
  const fingerprints = new Map<string, string>();
  const fingerprintOf = (authorization: string | undefined) => {
    if (!keep && !options.recordsFile) return null;
    const token = (authorization ?? '').replace(/^Bearer /, '');
    let fp = fingerprints.get(token);
    if (!fp) fingerprints.set(token, (fp = tokenFingerprint(token)));
    return fp;
  };
  const maxKept = options.maxKeptRecords ?? 200_000;
  let truncated = false;
  let stream: WriteStream | null = null;
  if (options.recordsFile) stream = createWriteStream(options.recordsFile, { encoding: 'utf8' });
  const emit = (r: RequestRecord) => {
    if (keep) {
      if (records.length < maxKept) records.push(r);
      else truncated = true;
    }
    stream?.write(`${JSON.stringify(r)}\n`);
  };

  let preflightResult: { ok: boolean; detail: string } | null = null;
  if (options.preflight ?? true) {
    preflightResult = await preflight(transport, identities, runId, timeoutMs);
    log(`preflight: ${preflightResult.ok ? 'ok' : 'FAILED'} (${preflightResult.detail})`);
  }

  if (options.startAt !== undefined) {
    const wait = options.startAt - Date.now();
    if (wait < -1000) throw new Error(`The common start time is ${Math.round(-wait / 1000)} s in the past`);
    if (wait > 0) {
      log(`waiting ${Math.round(wait / 1000)} s for the common start`);
      await sleep(wait);
    }
  }

  const monitor = startHealthMonitor();
  const startedAt = new Date().toISOString();
  const startEpochMs = Date.now();
  const t0 = performance.now();
  const now = () => performance.now() - t0;
  const inflight = new Set<Promise<void>>();
  let inFlight = 0;
  let inFlightMax = 0;
  let dropped = 0;
  let seq = 0;

  const dispatch = (atMs: number, phase: number) => {
    const n = seq++;
    options.hooks?.beforeDispatch?.(n);
    const planned = planner.next(n);
    const requestId = `${runId}-${shard.index}-${n}`;
    if ('exhausted' in planned) {
      const rec: RequestRecord = {
        seq: n,
        requestId,
        phase,
        category: planned.category,
        op: `unplannable:${planned.category}`,
        kind: 'read',
        probe: null,
        identityIndex: -1,
        context: 'none',
        token: 'live',
        tokenFingerprint: null,
        companyHeader: null,
        assignmentHeader: null,
        method: '-',
        path: '-',
        scheduledAtMs: atMs,
        dispatchedAtMs: null,
        sentAtMs: null,
        completedAtMs: null,
        latencyMs: null,
        serviceMs: null,
        status: null,
        errorCode: 'NO_ELIGIBLE_IDENTITY',
        outcome: 'NOT_SENT',
        inventoryKey: null,
      };
      collector.add(rec, null);
      emit(rec);
      return;
    }
    const x = identities[planned.identity]!;
    const headers = planned.spec.headers;
    const rec: RequestRecord = {
      seq: n,
      requestId,
      phase,
      category: planned.category,
      op: planned.op,
      kind: planned.kind,
      probe: planned.probe,
      identityIndex: x.index,
      context: planned.context,
      token: planned.token,
      tokenFingerprint: fingerprintOf(headers.authorization),
      companyHeader: headers['x-hrms-company'] ?? null,
      assignmentHeader: headers['x-hrms-assignment'] ?? null,
      method: planned.spec.method,
      path: planned.spec.path,
      scheduledAtMs: atMs,
      dispatchedAtMs: null,
      sentAtMs: null,
      completedAtMs: null,
      latencyMs: null,
      serviceMs: null,
      status: null,
      errorCode: null,
      outcome: 'NOT_SENT',
      inventoryKey: planned.inventoryKey,
    };
    if (inFlight >= maxInFlight) {
      dropped++;
      rec.errorCode = 'GENERATOR_IN_FLIGHT_LIMIT';
      collector.add(rec, planned.identity);
      emit(rec);
      return;
    }
    headers['x-request-id'] = requestId;
    rec.dispatchedAtMs = now();
    inFlight++;
    if (inFlight > inFlightMax) inFlightMax = inFlight;
    const complete = (res: TransportResult) => {
      rec.completedAtMs = now();
      rec.latencyMs = rec.completedAtMs - rec.scheduledAtMs;
      rec.serviceMs = rec.sentAtMs !== null ? rec.completedAtMs - rec.sentAtMs : null;
      rec.status = res.status;
      rec.errorCode = res.errorCode;
      rec.outcome = classify(planned, res);
      collector.add(rec, planned.identity);
      emit(rec);
    };
    const done = transport
      .send(planned.spec, {
        timeoutMs,
        wantBody: planned.wantBody,
        onSent: () => {
          rec.sentAtMs = now();
        },
      })
      .then(complete, () => complete({ outcome: 'NETWORK_ERROR', status: null, errorCode: 'TRANSPORT_ERROR', body: null }))
      .finally(() => {
        inFlight--;
        inflight.delete(done);
      });
    inflight.add(done);
  };

  // The scheduler loop: send everything that is due, then sleep until the next arrival. A late loop sends the
  // overdue arrivals immediately (recording their lateness); it never skips or postpones the schedule.
  if (!preflightResult || preflightResult.ok) {
    let next = schedule.next();
    await new Promise<void>((resolve) => {
      const tick = () => {
        let due = 0;
        while (next && next.atMs <= now()) {
          dispatch(next.atMs, next.phase);
          next = schedule.next();
          // Yield now and then so responses are processed even when a long backlog is due.
          if (++due >= 2000) break;
        }
        if (!next) {
          resolve();
          return;
        }
        const wait = next.atMs - now();
        if (wait > 2) setTimeout(tick, wait - 1);
        else setImmediate(tick);
      };
      tick();
    });
    await Promise.allSettled([...inflight]);
  }
  const finishedAt = new Date().toISOString();
  const drainSeconds = Math.max(0, Math.round((now() - scheduleMs) / 100) / 10);
  const proc = monitor.stop();
  if (ownsTransport) await transport.close();
  if (stream) {
    const s = stream;
    await new Promise<void>((resolve) => s.end(resolve));
  }

  const raw0 = collector.finish(planner.getStats(), []);
  const measurements: GeneratorMeasurements = {
    ...proc,
    sent: raw0.sent,
    lateSends: collector.lateSends,
    lateness: report0Summary(raw0.histograms.lateness),
    dispatchLag: report0Summary(raw0.histograms.dispatchLag),
    droppedByGenerator: dropped,
    inFlightMax,
    maxInFlight,
    preflight: preflightResult,
  };
  const entry = generatorEntry({ generatorId, region: options.region ?? null, shard, startEpochMs }, measurements, thresholds);
  const raw = { ...raw0, generators: [entry] };
  const ctx: RunContext = {
    runId,
    stage,
    ...(options.stageHoldSeconds !== undefined ? { stageHoldSeconds: options.stageHoldSeconds } : {}),
    profile,
    profileShares,
    arrival,
    mixSelection,
    seed,
    phases,
    timeoutMs,
    maxInFlight,
    negativeShare,
    target: targetLabel,
    startedAt,
    startEpochMs,
    finishedAt,
    drainSeconds,
    labels: { build: options.labels?.build ?? null, topology: options.labels?.topology ?? null, notes: options.labels?.notes ?? null },
    shardCount: shard.count,
    merged: false,
    mergedFrom: [generatorId],
    records: { kept: records.length, truncated, file: options.recordsFile ?? null },
    fixture: summarizeFixture(manifest),
    inventoryCheck,
  };
  const report = buildReport(raw, ctx);
  return { report, records, summary: formatSummary(report) };
}

const report0Summary = (h: SerializedHistogram) => LogHistogram.from(h).summary();

function sanitizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Merging distributed generator reports
// ---------------------------------------------------------------------------------------------------------------

/** Merges the reports of the generators of one distributed run (same fixture and schedule, disjoint shards). */
export function mergeReports(reports: readonly LoadReport[]): LoadReport {
  if (reports.length === 0) throw new Error('No reports to merge');
  const first = reports[0]!;
  const problems: string[] = [];
  const shards = new Set<number>();
  const otherSchema = reports.filter((r) => r.schema !== REPORT_SCHEMA).length;
  if (otherSchema) throw new Error(`Cannot merge: ${otherSchema} report(s) are not ${REPORT_SCHEMA} (merge the reports of one harness version)`);
  for (const r of reports) {
    if (r.fixture.fixtureId !== first.fixture.fixtureId) problems.push(`report ${r.run.id} uses fixture ${r.fixture.fixtureId}, not ${first.fixture.fixtureId}`);
    if (JSON.stringify(r.run.phases.map((p) => p.durationSeconds)) !== JSON.stringify(first.run.phases.map((p) => p.durationSeconds))) {
      problems.push(`report ${r.run.id} has different phase durations`);
    }
    if (r.run.profile !== first.run.profile || r.run.stage !== first.run.stage) problems.push(`report ${r.run.id} has a different profile or stage`);
    if (r.run.shardCount !== first.run.shardCount) problems.push(`report ${r.run.id} has a different shard count`);
    for (const g of r.raw.generators) {
      if (shards.has(g.shard.index)) problems.push(`shard ${g.shard.index} appears twice: identities would be counted twice`);
      shards.add(g.shard.index);
    }
  }
  if (problems.length) throw new Error(`Cannot merge: ${problems.join('; ')}`);
  const missing = [...Array(first.run.shardCount).keys()].filter((i) => !shards.has(i));
  const raw = mergeAggregates(reports.map((r) => r.raw));
  const inventory = new Map<string, { op: string; expected: number; available: number }>();
  for (const r of reports) {
    for (const i of r.fixture.inventoryCheck) {
      const o = inventory.get(i.op);
      if (o) {
        o.expected += i.expected;
        o.available += i.available;
      } else inventory.set(i.op, { ...i });
    }
  }
  const { inventoryCheck: _i, sufficient: _s, reasons: _r, ...fixture } = first.fixture;
  const ctx: RunContext = {
    runId: `${first.run.id}+${reports.length - 1}`,
    stage: first.run.stage,
    ...(first.verdict.stage.required.holdSeconds !== undefined && first.verdict.stage.required.holdSeconds !== STAGES[first.run.stage].holdSeconds
      ? { stageHoldSeconds: first.verdict.stage.required.holdSeconds }
      : {}),
    profile: first.run.profile,
    profileShares: first.mix.target as Record<Category, number>,
    arrival: first.run.arrival as 'uniform' | 'poisson',
    mixSelection: first.run.mixSelection as 'deficit' | 'random',
    seed: first.run.seed,
    // The offered schedule of a distributed run is the sum of its generators' schedules.
    phases: first.run.phases.map((p, i) => ({ ratePerSecond: reports.reduce((t, r) => t + (r.run.phases[i]?.ratePerSecond ?? 0), 0), durationSeconds: p.durationSeconds })),
    timeoutMs: first.run.timeoutMs,
    maxInFlight: reports.reduce((t, r) => t + r.run.maxInFlight, 0),
    negativeShare: first.run.negativeShare,
    target: first.run.target,
    startedAt: reports.map((r) => r.run.startedAt).sort()[0]!,
    startEpochMs: Math.min(...reports.map((r) => r.run.startEpochMs)),
    finishedAt: reports.map((r) => r.run.finishedAt).sort().at(-1)!,
    drainSeconds: Math.max(...reports.map((r) => r.run.drainSeconds)),
    labels: { build: first.environment.build, topology: first.environment.topology, notes: first.environment.notes },
    shardCount: first.run.shardCount,
    merged: missing.length === 0,
    mergedFrom: reports.flatMap((r) => r.raw.generators.map((g) => g.generatorId)),
    records: { kept: reports.reduce((t, r) => t + r.records.kept, 0), truncated: reports.some((r) => r.records.truncated), file: null },
    fixture,
    inventoryCheck: [...inventory.values()],
  };
  const report = buildReport(raw, ctx);
  if (missing.length) report.verdict.stage.reasons.push(`shards missing from the merge: ${missing.join(', ')}`);
  return report;
}

/** Fixture states consumed by earlier runs: every inventoryKey of their request records (sent or not, to be safe). */
export function consumedKeys(records: Iterable<Pick<RequestRecord, 'inventoryKey' | 'dispatchedAtMs'>>): Set<string> {
  const keys = new Set<string>();
  for (const r of records) if (r.inventoryKey && r.dispatchedAtMs !== null) keys.add(r.inventoryKey);
  return keys;
}

async function consumedFromFiles(files: string[]): Promise<Set<string>> {
  const all = new Set<string>();
  for (const file of files) {
    const lines = (await readFile(file, 'utf8')).split('\n').filter((l) => l.trim());
    for (const k of consumedKeys(lines.map((l) => JSON.parse(l) as RequestRecord))) all.add(k);
  }
  return all;
}

// ---------------------------------------------------------------------------------------------------------------
// Route sweep and run planning (before a long run)
// ---------------------------------------------------------------------------------------------------------------

const addDays = (day: string, n: number) => {
  const t = new Date(`${day}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

export interface SweepRow {
  op: string;
  probe: string | null;
  identityIndex: number;
  role: string;
  context: ContextKind;
  method: string;
  path: string;
  status: number | null;
  errorCode: string | null;
  outcome: Outcome;
  serviceMs: number | null;
}

export interface SweepResult {
  /** Every scripted operation was accepted and every negative probe was denied as expected. */
  ok: boolean;
  /** Probes allowed or responses for another identity: integrity failures, whatever the load. */
  integrityFailures: number;
  rows: SweepRow[];
  /** Operations and probes that no identity of this fixture (shard) can issue. */
  uncovered: string[];
  problems: string[];
  /** The sweep's requests in the run-record format: pass them to later runs (--consumed-from) to skip what it used. */
  records: RequestRecord[];
}

export interface SweepOptions {
  target: string | Transport;
  fixture: LoadedFixture;
  /** Leave dates of the sweep's own submissions; default ten years after the business date, clear of any run. */
  leaveDateFrom?: string;
  consumed?: ReadonlySet<string>;
  timeoutMs?: number;
  /** Pause between requests; the sweep sends one request at a time. */
  paceMs?: number;
  seed?: number;
}

/**
 * Sends one request for every operation of the mix and every negative probe kind, one at a time, as fixture
 * identities: a scripted request that is refused or a probe that is not denied as expected means the workload no
 * longer matches the API (or the fixture), so a run would measure the harness instead of the system. It is not load
 * and proves nothing about capacity. It consumes a few fixture states (one decision, resubmission, withdrawal and
 * correction); pass its records to later runs.
 */
export async function sweepWorkload(options: SweepOptions): Promise<SweepResult> {
  const { manifest, identities } = options.fixture;
  if (identities.length === 0) throw new Error('The fixture (shard) has no identities');
  const runId = `lt${randomBytes(4).toString('hex')}`;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const paceMs = options.paceMs ?? 100;
  const planner = new WorkloadPlanner(identities, {
    runId,
    profile: PROFILES.nominal,
    negativeShare: 0,
    seed: options.seed ?? 1,
    businessDate: manifest.businessDate,
    leaveDateFrom: options.leaveDateFrom ?? addDays(manifest.businessDate, 3653),
    ...(options.consumed ? { consumed: options.consumed } : {}),
  });
  const { requests, uncovered } = planner.sampleAll(0);
  const transport = typeof options.target === 'string' ? httpTransport(options.target, { maxSockets: 2 }) : options.target;
  const rows: SweepRow[] = [];
  const records: RequestRecord[] = [];
  const t0 = performance.now();
  const now = () => performance.now() - t0;
  try {
    for (const [n, planned] of requests.entries()) {
      if (n > 0 && paceMs > 0) await sleep(paceMs);
      const x = identities[planned.identity]!;
      const headers = planned.spec.headers;
      const rec: RequestRecord = {
        seq: n,
        requestId: `${runId}-sweep-${n}`,
        phase: 0,
        category: planned.category,
        op: planned.op,
        kind: planned.kind,
        probe: planned.probe,
        identityIndex: x.index,
        context: planned.context,
        token: planned.token,
        tokenFingerprint: tokenFingerprint((headers.authorization ?? '').replace(/^Bearer /, '')),
        companyHeader: headers['x-hrms-company'] ?? null,
        assignmentHeader: headers['x-hrms-assignment'] ?? null,
        method: planned.spec.method,
        path: planned.spec.path,
        scheduledAtMs: now(),
        dispatchedAtMs: null,
        sentAtMs: null,
        completedAtMs: null,
        latencyMs: null,
        serviceMs: null,
        status: null,
        errorCode: null,
        outcome: 'NOT_SENT',
        inventoryKey: planned.inventoryKey,
      };
      headers['x-request-id'] = rec.requestId;
      rec.dispatchedAtMs = rec.scheduledAtMs;
      const res = await transport
        .send(planned.spec, { timeoutMs, wantBody: planned.wantBody, onSent: () => (rec.sentAtMs = now()) })
        .catch((): TransportResult => ({ outcome: 'NETWORK_ERROR', status: null, errorCode: 'TRANSPORT_ERROR', body: null }));
      rec.completedAtMs = now();
      rec.latencyMs = rec.completedAtMs - rec.scheduledAtMs;
      rec.serviceMs = rec.sentAtMs !== null ? rec.completedAtMs - rec.sentAtMs : null;
      rec.status = res.status;
      rec.errorCode = res.errorCode;
      rec.outcome = classify(planned, res);
      records.push(rec);
      rows.push({
        op: rec.op,
        probe: rec.probe,
        identityIndex: rec.identityIndex,
        role: x.contexts[planned.context === 'own' ? 'own' : 'primary'].role,
        context: rec.context,
        method: rec.method,
        path: rec.path,
        status: rec.status,
        errorCode: rec.errorCode,
        outcome: rec.outcome,
        serviceMs: rec.serviceMs === null ? null : Math.round(rec.serviceMs * 10) / 10,
      });
    }
  } finally {
    if (typeof options.target === 'string') await transport.close();
  }
  const problems = rows
    .filter((r) => (r.probe ? r.outcome !== 'DENIED_AS_EXPECTED' : r.outcome !== 'OK'))
    .map((r) => `${r.op} as identity #${r.identityIndex} (${r.role}, ${r.method} ${r.path.replace(/\?.*$/, '')}): ${r.outcome} ${r.status ?? ''} ${r.errorCode ?? ''}`.replace(/\s+/g, ' ').trim());
  const integrityFailures = rows.filter((r) => r.outcome === 'UNEXPECTEDLY_ALLOWED' || r.outcome === 'IDENTITY_MISMATCH').length;
  return { ok: problems.length === 0, integrityFailures, rows, uncovered, problems, records };
}

export interface RunPlan {
  fixtureId: string;
  identities: number;
  expectedArrivals: number;
  /** Mean seconds between two requests of one identity over the schedule (G1 models 10 s). */
  meanIntervalSeconds: number | null;
  /** Consumable fixture states the schedule needs against those the fixture holds (a shortfall blocks the run). */
  inventory: { op: string; expected: number; available: number; sufficient: boolean }[];
  /** Operations and probes with no eligible identity in this fixture (shard); their share goes to the others. */
  uncovered: string[];
  sufficient: boolean;
}

/** Sizes a schedule against a fixture without sending anything (run it before a long stage run). */
export function planRun(
  fixture: LoadedFixture,
  phases: Phase[],
  opts: { profile?: ProfileName; negativeShare?: number; consumed?: ReadonlySet<string>; leaveDateFrom?: string } = {},
): RunPlan {
  const profile = PROFILES[opts.profile ?? 'nominal'];
  if (!profile) throw new Error(`Unknown profile ${String(opts.profile)}`);
  const planner = new WorkloadPlanner(fixture.identities, {
    runId: 'plan',
    profile,
    negativeShare: opts.negativeShare ?? 0.02,
    seed: 1,
    businessDate: fixture.manifest.businessDate,
    ...(opts.consumed ? { consumed: opts.consumed } : {}),
    ...(opts.leaveDateFrom ? { leaveDateFrom: opts.leaveDateFrom } : {}),
  });
  const expectedArrivals = Math.ceil(ArrivalSchedule.expectedArrivals(phases));
  const inventory = planner.inventoryCheck(expectedArrivals).map((i) => ({ ...i, sufficient: i.expected <= i.available }));
  const uncovered = Object.entries(planner.poolSizes())
    .filter(([, n]) => n === 0)
    .map(([k]) => k);
  const seconds = phases.reduce((t, p) => t + p.durationSeconds, 0);
  return {
    fixtureId: fixture.manifest.fixtureId,
    identities: fixture.identities.length,
    expectedArrivals,
    meanIntervalSeconds: expectedArrivals > 0 ? Math.round((fixture.identities.length * seconds * 1000) / expectedArrivals) / 1000 : null,
    inventory,
    uncovered,
    sufficient: inventory.every((i) => i.sufficient),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------------------

export function parsePhases(spec: string): Phase[] {
  return spec.split(',').map((part) => {
    const [rate, duration] = part.split(':').map((s) => Number(s.trim()));
    if (rate === undefined || duration === undefined || !Number.isFinite(rate) || !Number.isFinite(duration) || rate < 0 || duration <= 0) {
      throw new Error(`Invalid phase "${part}" (use rate:durationSeconds, e.g. 50:60,100:60)`);
    }
    return { ratePerSecond: rate, durationSeconds: duration };
  });
}

function parseShard(spec: string | undefined): { index: number; count: number } {
  if (!spec) return { index: 0, count: 1 };
  const m = /^(\d+)\/(\d+)$/.exec(spec);
  if (!m) throw new Error('--shard must look like i/n (0-based), e.g. 0/4');
  const shard = { index: Number(m[1]), count: Number(m[2]) };
  if (shard.count < 1 || shard.index >= shard.count) throw new Error('--shard index must be below the count');
  return shard;
}

function parseStart(spec: string | undefined): number | undefined {
  if (!spec) return undefined;
  const n = /^\d+$/.test(spec) ? Number(spec) : Date.parse(spec);
  if (!Number.isFinite(n)) throw new Error('--start-at must be epoch milliseconds or an ISO time');
  return n;
}

const exitCodeOf = (v: string) => (v === 'PASS' ? 0 : v === 'FAIL' ? 2 : 3);

async function writeOutputs(dir: string, report: LoadReport): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(join(dir, 'summary.txt'), `${formatSummary(report)}\n`, 'utf8');
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      target: { type: 'string' },
      manifest: { type: 'string' },
      rate: { type: 'string' },
      duration: { type: 'string' },
      phases: { type: 'string' },
      profile: { type: 'string' },
      arrival: { type: 'string' },
      mix: { type: 'string' },
      seed: { type: 'string' },
      'timeout-ms': { type: 'string' },
      'max-in-flight': { type: 'string' },
      'negative-share': { type: 'string' },
      'consumed-from': { type: 'string' },
      'leave-from': { type: 'string' },
      stage: { type: 'string' },
      'stage-hold-seconds': { type: 'string' },
      shard: { type: 'string' },
      'start-at': { type: 'string' },
      'generator-id': { type: 'string' },
      region: { type: 'string' },
      build: { type: 'string' },
      topology: { type: 'string' },
      notes: { type: 'string' },
      out: { type: 'string' },
      records: { type: 'boolean' },
      'no-preflight': { type: 'boolean' },
      'late-threshold-ms': { type: 'string' },
      'max-late-fraction': { type: 'string' },
      'max-loop-p99-ms': { type: 'string' },
      'max-loop-busy': { type: 'string' },
      'max-cpu': { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  const command = positionals[0];
  if (values.help || !['run', 'merge', 'plan', 'sweep'].includes(command ?? '')) {
    console.log('Usage: npx tsx load/generator.ts run --target URL --manifest DIR (--rate N --duration S | --phases r:s,...) [--profile nominal|write-heavy] [--stage NAME] [--out DIR]');
    console.log('       npx tsx load/generator.ts merge --out DIR shard-0/report.json shard-1/report.json ...');
    console.log('       npx tsx load/generator.ts plan --manifest DIR (--rate N --duration S | --phases r:s,...) [--profile P] [--shard i/n]   (sizing only, sends nothing)');
    console.log('       npx tsx load/generator.ts sweep --target URL --manifest DIR [--shard i/n] [--out DIR]   (one request per operation and probe)');
    console.log('Exit code: 0 PASS, 2 FAIL, 3 BLOCKED (plan: 3 when the fixture is too small; sweep: 2 on an integrity failure, 3 on a mismatch). See load/README.md.');
    return values.help ? 0 : 1;
  }
  if (values.profile !== undefined && !(values.profile in PROFILES)) throw new Error(`--profile must be one of ${Object.keys(PROFILES).join(', ')}`);
  if (values.arrival !== undefined && values.arrival !== 'uniform' && values.arrival !== 'poisson') throw new Error('--arrival must be uniform or poisson');
  if (values.mix !== undefined && values.mix !== 'deficit' && values.mix !== 'random') throw new Error('--mix must be deficit or random');
  if (values.stage !== undefined && !(values.stage in STAGES)) throw new Error(`--stage must be one of ${Object.keys(STAGES).join(', ')}`);
  const log = (line: string) => console.error(`[generator] ${line}`);
  const num = (name: string): number | undefined => {
    const v = values[name as keyof typeof values];
    if (v === undefined || typeof v === 'boolean') return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`--${name} must be a number`);
    return n;
  };
  const opt = <T>(v: T | undefined) => (v === undefined ? {} : v);

  if (command === 'merge') {
    if (!values.out) throw new Error('Pass --out DIR');
    const files = positionals.slice(1);
    if (files.length === 0) throw new Error('Pass the shard report.json files to merge');
    const reports = await Promise.all(files.map(async (f) => JSON.parse(await readFile(f, 'utf8')) as LoadReport));
    const merged = mergeReports(reports);
    await writeOutputs(values.out, merged);
    console.log(formatSummary(merged));
    return exitCodeOf(merged.verdict.run);
  }

  if (!values.manifest) throw new Error('Pass --manifest DIR (from load/fixtures.ts)');
  const phases = values.phases ? parsePhases(values.phases) : parsePhases(`${values.rate ?? '5'}:${values.duration ?? '30'}`);
  const shard = parseShard(values.shard);
  const fixture = await readManifest(values.manifest, shard);
  log(`loaded ${fixture.identities.length} identities (shard ${shard.index}/${shard.count}) of fixture ${fixture.manifest.fixtureId}`);
  const consumedFrom = async () => (values['consumed-from'] ? consumedFromFiles(values['consumed-from'].split(',').map((s) => s.trim())) : undefined);

  if (command === 'plan') {
    const consumed = await consumedFrom();
    const ns = num('negative-share');
    const plan = planRun(fixture, phases, {
      ...(values.profile ? { profile: values.profile as ProfileName } : {}),
      ...(ns !== undefined ? { negativeShare: ns } : {}),
      ...(consumed ? { consumed } : {}),
      ...(values['leave-from'] ? { leaveDateFrom: values['leave-from'] } : {}),
    });
    console.log(JSON.stringify(plan, null, 2));
    if (!plan.sufficient) log('the fixture inventory is too small for this schedule: the run would be BLOCKED (see load/README.md, sizing)');
    return plan.sufficient ? 0 : 3;
  }

  if (!values.target) throw new Error('Pass --target URL (the API under test)');

  if (command === 'sweep') {
    const consumed = await consumedFrom();
    const sweep = await sweepWorkload({
      target: values.target,
      fixture,
      ...(consumed ? { consumed } : {}),
      ...(values['leave-from'] ? { leaveDateFrom: values['leave-from'] } : {}),
      ...opt(num('timeout-ms') !== undefined ? { timeoutMs: num('timeout-ms')! } : undefined),
    });
    for (const r of sweep.rows) console.log(`${r.outcome.padEnd(20)} ${String(r.status ?? '-').padStart(3)}  ${r.op.padEnd(30)} #${r.identityIndex} ${r.role}`);
    for (const u of sweep.uncovered) console.log(`not covered by this fixture: ${u}`);
    for (const p of sweep.problems) log(`problem: ${p}`);
    if (values.out) {
      await mkdir(values.out, { recursive: true });
      const { records, ...summary } = sweep;
      await writeFile(join(values.out, 'sweep.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
      await writeFile(join(values.out, 'sweep-records.ndjson'), records.map((r) => `${JSON.stringify(r)}\n`).join(''), 'utf8');
      log(`pass --consumed-from ${join(values.out, 'sweep-records.ndjson')} to the next run on this fixture`);
    }
    return sweep.integrityFailures > 0 ? 2 : sweep.ok ? 0 : 3;
  }
  const thresholds: Partial<HealthThresholds> = {};
  const lt = num('late-threshold-ms');
  if (lt !== undefined) thresholds.lateThresholdMs = lt;
  const lf = num('max-late-fraction');
  if (lf !== undefined) thresholds.maxLateFraction = lf;
  const lp = num('max-loop-p99-ms');
  if (lp !== undefined) thresholds.maxEventLoopP99Ms = lp;
  const mc = num('max-cpu');
  if (mc !== undefined) thresholds.maxCpuUtilisation = mc;
  const mb = num('max-loop-busy');
  if (mb !== undefined) thresholds.maxEventLoopUtilisation = mb;
  if (values.out) await mkdir(values.out, { recursive: true });
  const startAt = parseStart(values['start-at']);
  const consumed = await consumedFrom();
  if (consumed) log(`skipping ${consumed.size} fixture states consumed by earlier runs`);
  const result = await runLoad({
    target: values.target,
    fixture,
    phases,
    ...(values.profile ? { profile: values.profile as ProfileName } : {}),
    ...(values.arrival ? { arrival: values.arrival as 'uniform' | 'poisson' } : {}),
    ...(values.mix ? { mixSelection: values.mix as 'deficit' | 'random' } : {}),
    ...opt(num('seed') !== undefined ? { seed: num('seed')! } : undefined),
    ...opt(num('timeout-ms') !== undefined ? { timeoutMs: num('timeout-ms')! } : undefined),
    ...opt(num('max-in-flight') !== undefined ? { maxInFlight: num('max-in-flight')! } : undefined),
    ...opt(num('negative-share') !== undefined ? { negativeShare: num('negative-share')! } : undefined),
    ...(consumed ? { consumed } : {}),
    ...(values['leave-from'] ? { leaveDateFrom: values['leave-from'] } : {}),
    ...(values.stage ? { stage: values.stage as StageName } : {}),
    ...opt(num('stage-hold-seconds') !== undefined ? { stageHoldSeconds: num('stage-hold-seconds')! } : undefined),
    shard,
    ...(startAt !== undefined ? { startAt } : {}),
    ...(values['generator-id'] ? { generatorId: values['generator-id'] } : {}),
    ...(values.region ? { region: values.region } : {}),
    labels: { ...(values.build ? { build: values.build } : {}), ...(values.topology ? { topology: values.topology } : {}), ...(values.notes ? { notes: values.notes } : {}) },
    ...(values.records && values.out ? { recordsFile: join(values.out, 'records.ndjson') } : {}),
    preflight: values['no-preflight'] !== true,
    thresholds,
    log,
  });
  const missing = missingReportFields(result.report);
  if (missing.length) log(`report is missing fields: ${missing.join(', ')}`);
  if (values.out) await writeOutputs(values.out, result.report);
  console.log(result.summary);
  return exitCodeOf(result.report.verdict.run);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: Error) => {
      console.error(`[generator] ${err.message}`);
      process.exitCode = 1;
    });
}
