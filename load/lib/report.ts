// Run aggregation, the JSON report and its verdicts. Latency is measured from each request's SCHEDULED time
// (coordinated-omission safe: a generator or system stall shows up as latency instead of disappearing). Every
// aggregate is mergeable, so the reports of distributed generators combine exactly (counts add, histograms add).
//
// Verdict rules (BRD v8.2 G4/G5): an integrity failure is a FAIL at any scale; an unhealthy generator or an
// insufficient fixture makes the run BLOCKED; S03 limits are evaluated per operation (and per region when the
// generators are labelled with one); a G4 stage is evidenced only by a run whose hold reached the stage's identity
// count and offered rate for the stage's duration, with every fixture role issuing positive and negative requests;
// ZT31-ZT35 are PASS only with full-scale evidence reviewed by people, so a single run never marks a gate passed.
// No capacity is claimed from a small run.
import { type LatencySummary, LogHistogram, type SerializedHistogram } from './histogram.js';
import { assessGeneratorHealth, type GeneratorMeasurements, type HealthThresholds } from './health.js';
import type { FixtureManifest } from './manifest.js';
import { CATEGORIES, CATEGORY_LABELS, type Category, type ContextKind, type PlannerStats, type TokenKind } from './workload.js';

export const REPORT_SCHEMA = 'hrms-load-report/2';
export const HARNESS_VERSION = '1.1.0';

export type Verdict = 'PASS' | 'FAIL' | 'BLOCKED';

export type Outcome =
  | 'OK'
  | 'DENIED_AS_EXPECTED'
  | 'UNEXPECTEDLY_ALLOWED'
  | 'IDENTITY_MISMATCH'
  | 'PROBE_WRONG_STATUS'
  | 'REJECTED'
  | 'THROTTLED'
  | 'SERVER_ERROR'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'NOT_SENT';

export const OUTCOMES: readonly Outcome[] = [
  'OK',
  'DENIED_AS_EXPECTED',
  'UNEXPECTEDLY_ALLOWED',
  'IDENTITY_MISMATCH',
  'PROBE_WRONG_STATUS',
  'REJECTED',
  'THROTTLED',
  'SERVER_ERROR',
  'TIMEOUT',
  'NETWORK_ERROR',
  'NOT_SENT',
];

/** One request as the generator saw it. Times are milliseconds since the run's start (performance clock). */
export interface RequestRecord {
  seq: number;
  /** The x-request-id sent, so the request can be found in server logs. */
  requestId: string;
  phase: number;
  category: Category;
  op: string;
  kind: 'read' | 'mutation';
  probe: string | null;
  /** Manifest index of the identity that issued it. */
  identityIndex: number;
  context: ContextKind;
  token: TokenKind;
  /** Fingerprint of the bearer token sent (never the token). */
  tokenFingerprint: string | null;
  companyHeader: string | null;
  assignmentHeader: string | null;
  method: string;
  path: string;
  scheduledAtMs: number;
  dispatchedAtMs: number | null;
  sentAtMs: number | null;
  completedAtMs: number | null;
  /** completedAt - scheduledAt: includes any delay before sending (coordinated-omission safe). */
  latencyMs: number | null;
  /** completedAt - sentAt: the service time alone, for diagnosis only. */
  serviceMs: number | null;
  status: number | null;
  errorCode: string | null;
  outcome: Outcome;
  /** The fixture state this request consumed (pass earlier records to a later run so it skips them). */
  inventoryKey: string | null;
}

export interface Phase {
  ratePerSecond: number;
  durationSeconds: number;
}

type Counts = Record<string, number>;
const inc = (c: Counts, k: string, n = 1) => {
  c[k] = (c[k] ?? 0) + n;
};
const addCounts = (into: Counts, from: Counts) => {
  for (const [k, v] of Object.entries(from)) inc(into, k, v);
};
const emptyOutcomes = (): Counts => Object.fromEntries(OUTCOMES.map((o) => [o, 0]));
const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** Failures in NFR-S03's error budget: timeout, 5xx, throttle and non-response (dropped requests count). */
const S03_FAILURES: readonly Outcome[] = ['SERVER_ERROR', 'THROTTLED', 'TIMEOUT', 'NETWORK_ERROR', 'NOT_SENT'];
/** Zero-tolerance integrity failures (G4). */
const INTEGRITY_FAILURES: readonly Outcome[] = ['UNEXPECTEDLY_ALLOWED', 'IDENTITY_MISMATCH'];
/** Offered rates are compared with a stage rate within this factor (Poisson arrivals vary slightly). */
const RATE_TOLERANCE = 0.999;
/** Region key of generators that were not given a region label. */
export const UNLABELLED_REGION = 'unlabelled';

interface OpAggregate {
  category: Category;
  kind: 'read' | 'mutation';
  probe: string | null;
  offered: number;
  sent: number;
  completed: number;
  outcomes: Counts;
  statusCounts: Counts;
  latency: SerializedHistogram;
  service: SerializedHistogram;
}

interface PhaseAggregate {
  offered: number;
  sent: number;
  completed: number;
  lateSends: number;
  outcomes: Counts;
  /** Arrivals that were not negative probes, and their outcomes (the NFR-S03 denominator). */
  validOffered: number;
  validOutcomes: Counts;
  overall: SerializedHistogram;
  reads: SerializedHistogram;
  mutations: SerializedHistogram;
  /** Positive requests per operation for per-step S03 checks. */
  byOperation: Record<string, { kind: 'read' | 'mutation'; latency: SerializedHistogram }>;
}

/** Requests by the identities of one role or company tier; positive and negative count requests actually sent. */
export interface CohortCounts {
  available: number;
  used: number;
  requests: number;
  positive: number;
  negative: number;
}

export interface RegionHistograms {
  overall: SerializedHistogram;
  reads: SerializedHistogram;
  mutations: SerializedHistogram;
}

export interface GeneratorEntry {
  generatorId: string;
  region: string | null;
  shard: { index: number; count: number };
  startEpochMs: number;
  healthy: boolean;
  reasons: string[];
  thresholds: HealthThresholds;
  measurements: GeneratorMeasurements;
}

/** Everything a report is computed from; additive across shards. */
export interface RawAggregate {
  offered: number;
  sent: number;
  completed: number;
  outcomes: Counts;
  /** Arrivals that were not negative probes: NFR-S03's "offered valid requests". */
  valid: { offered: number; outcomes: Counts };
  /** Sends and completions that happened inside the scheduled window (the rest were late or completed in the drain). */
  inWindow: { sent: number; completed: number };
  notSentReasons: Counts;
  statusCounts: Counts;
  /** Error codes of requests that did not end as expected (negative probes denied as expected are excluded). */
  errorCodes: Counts;
  /** Error codes of negative probes that were denied as expected (authentication and authorization outcomes). */
  deniedByCode: Counts;
  operations: Record<string, OpAggregate>;
  histograms: {
    overall: SerializedHistogram;
    reads: SerializedHistogram;
    mutations: SerializedHistogram;
    probes: SerializedHistogram;
    lateness: SerializedHistogram;
    dispatchLag: SerializedHistogram;
    serviceOverall: SerializedHistogram;
    byCategory: Record<string, SerializedHistogram>;
    /** Positive requests by the role of the identity that issued them (G4: cohorts, not pooled averages). */
    byRole: Record<string, SerializedHistogram>;
    /** Positive requests by company tier (HOT, LARGE, TAIL): the hot company cannot hide in the average (G2). */
    byTier: Record<string, SerializedHistogram>;
    /** Positive requests by the region label of the generator that sent them. */
    byRegion: Record<string, RegionHistograms>;
  };
  phases: PhaseAggregate[];
  /** [second since start, offered, sent, completed, failures] */
  timeline: [number, number, number, number, number][];
  identities: {
    available: number;
    used: number;
    maxPerIdentity: number;
    requests: number;
    /** [minute window index since start, distinct identities active in it] */
    windows: [number, number][];
    byRole: Record<string, CohortCounts>;
    byTier: Record<string, CohortCounts>;
    companiesUsed: string[];
  };
  planner: PlannerStats;
  probes: Record<string, { planned: number; denied: number; allowed: number; wrongStatus: number; other: number }>;
  generators: GeneratorEntry[];
}

export interface IdentityMeta {
  index: number;
  role: string;
  tier: string;
  companyId: string;
}

const emptyCohort = (): CohortCounts => ({ available: 0, used: 0, requests: 0, positive: 0, negative: 0 });
const histogramMapJSON = (m: Map<string, LogHistogram>) => Object.fromEntries([...m.entries()].map(([k, v]) => [k, v.toJSON()]));
const recordInto = (m: Map<string, LogHistogram>, key: string, v: number) => {
  let h = m.get(key);
  if (!h) m.set(key, (h = new LogHistogram()));
  h.record(v);
};

/** Accumulates request records into a RawAggregate (bounded memory: histograms, counters, per-identity counters). */
export class Collector {
  private readonly ops = new Map<string, { a: OpAggregate; latency: LogHistogram; service: LogHistogram }>();
  private readonly h = {
    overall: new LogHistogram(),
    reads: new LogHistogram(),
    mutations: new LogHistogram(),
    probes: new LogHistogram(),
    lateness: new LogHistogram(),
    dispatchLag: new LogHistogram(),
    serviceOverall: new LogHistogram(),
    byCategory: new Map<string, LogHistogram>(),
    byRole: new Map<string, LogHistogram>(),
    byTier: new Map<string, LogHistogram>(),
  };
  private readonly regionHist = { overall: new LogHistogram(), reads: new LogHistogram(), mutations: new LogHistogram() };
  private readonly phases: {
    a: Omit<PhaseAggregate, 'overall' | 'reads' | 'mutations' | 'byOperation'>;
    overall: LogHistogram;
    reads: LogHistogram;
    mutations: LogHistogram;
    byOperation: Map<string, { kind: 'read' | 'mutation'; latency: LogHistogram }>;
  }[];
  private readonly timeline = new Map<number, [number, number, number, number]>();
  private readonly perIdentity: Uint32Array;
  private readonly positiveSent: Uint32Array;
  private readonly negativeSent: Uint32Array;
  private readonly lastWindow: Int32Array;
  private readonly windows = new Map<number, number>();
  private readonly companiesUsed = new Set<string>();
  readonly raw: Omit<RawAggregate, 'operations' | 'histograms' | 'phases' | 'timeline' | 'identities' | 'planner' | 'generators'>;
  lateSends = 0;

  /**
   * `scheduleMs` is the length of the arrival schedule (sends and completions after it are outside the window);
   * `region` labels this generator's latency cohort.
   */
  constructor(
    private readonly identities: readonly IdentityMeta[],
    phaseCount: number,
    private readonly lateThresholdMs: number,
    private readonly scheduleMs: number = Number.POSITIVE_INFINITY,
    private readonly region: string = UNLABELLED_REGION,
  ) {
    this.perIdentity = new Uint32Array(identities.length);
    this.positiveSent = new Uint32Array(identities.length);
    this.negativeSent = new Uint32Array(identities.length);
    this.lastWindow = new Int32Array(identities.length).fill(-1);
    this.phases = Array.from({ length: phaseCount }, () => ({
      a: { offered: 0, sent: 0, completed: 0, lateSends: 0, outcomes: emptyOutcomes(), validOffered: 0, validOutcomes: emptyOutcomes() },
      overall: new LogHistogram(),
      reads: new LogHistogram(),
      mutations: new LogHistogram(),
      byOperation: new Map(),
    }));
    this.raw = {
      offered: 0,
      sent: 0,
      completed: 0,
      outcomes: emptyOutcomes(),
      valid: { offered: 0, outcomes: emptyOutcomes() },
      inWindow: { sent: 0, completed: 0 },
      notSentReasons: {},
      statusCounts: {},
      errorCodes: {},
      deniedByCode: {},
      probes: {},
    };
  }

  private tick(ms: number | null, slot: 0 | 1 | 2 | 3) {
    if (ms === null) return;
    const s = Math.max(0, Math.floor(ms / 1000));
    const t = this.timeline.get(s) ?? [0, 0, 0, 0];
    t[slot]++;
    this.timeline.set(s, t);
  }

  /** `position` is the identity's position in the loaded list (null when the arrival had no identity). */
  add(r: RequestRecord, position: number | null): void {
    const raw = this.raw;
    raw.offered++;
    inc(raw.outcomes, r.outcome);
    if (r.probe === null) {
      raw.valid.offered++;
      inc(raw.valid.outcomes, r.outcome);
    }
    // Sent = handed to the transport by the scheduler; arrivals the generator could not issue are NOT_SENT.
    const sent = r.dispatchedAtMs !== null;
    if (sent) {
      raw.sent++;
      if ((r.sentAtMs ?? r.dispatchedAtMs!) <= this.scheduleMs) raw.inWindow.sent++;
    }
    if (r.status !== null) {
      raw.completed++;
      inc(raw.statusCounts, String(r.status));
      if (r.completedAtMs !== null && r.completedAtMs <= this.scheduleMs) raw.inWindow.completed++;
    }
    if (r.outcome === 'NOT_SENT') inc(raw.notSentReasons, r.errorCode ?? 'UNKNOWN');
    if (r.outcome === 'DENIED_AS_EXPECTED') inc(raw.deniedByCode, r.errorCode ?? `HTTP_${r.status ?? 0}`);
    else if (r.errorCode && r.outcome !== 'OK') inc(raw.errorCodes, r.errorCode);

    let op = this.ops.get(r.op);
    if (!op) {
      op = {
        a: { category: r.category, kind: r.kind, probe: r.probe, offered: 0, sent: 0, completed: 0, outcomes: emptyOutcomes(), statusCounts: {}, latency: null!, service: null! },
        latency: new LogHistogram(),
        service: new LogHistogram(),
      };
      this.ops.set(r.op, op);
    }
    op.a.offered++;
    if (sent) op.a.sent++;
    if (r.status !== null) {
      op.a.completed++;
      inc(op.a.statusCounts, String(r.status));
    }
    inc(op.a.outcomes, r.outcome);

    // Latency (from the scheduled time) for every request that got an answer or timed out; a timeout counts at
    // least as slow as its deadline. Network errors and unsent arrivals are failures without a latency.
    const timed = r.latencyMs !== null && (r.status !== null || r.outcome === 'TIMEOUT');
    const phase = this.phases[r.phase];
    const id = position !== null ? this.identities[position] : undefined;
    if (phase) {
      phase.a.offered++;
      if (sent) phase.a.sent++;
      if (r.status !== null) phase.a.completed++;
      inc(phase.a.outcomes, r.outcome);
      if (r.probe === null) {
        phase.a.validOffered++;
        inc(phase.a.validOutcomes, r.outcome);
      }
    }
    if (timed) {
      const v = r.latencyMs!;
      op.latency.record(v);
      if (r.probe) this.h.probes.record(v);
      else {
        const byKind = r.kind === 'read' ? 'reads' : 'mutations';
        this.h.overall.record(v);
        this.h[byKind].record(v);
        recordInto(this.h.byCategory, r.category, v);
        if (id) {
          recordInto(this.h.byRole, id.role, v);
          recordInto(this.h.byTier, id.tier, v);
        }
        this.regionHist.overall.record(v);
        this.regionHist[byKind].record(v);
        if (phase) {
          phase.overall.record(v);
          phase[byKind].record(v);
          let po = phase.byOperation.get(r.op);
          if (!po) phase.byOperation.set(r.op, (po = { kind: r.kind, latency: new LogHistogram() }));
          po.latency.record(v);
        }
      }
      if (r.serviceMs !== null) {
        op.service.record(r.serviceMs);
        this.h.serviceOverall.record(r.serviceMs);
      }
    }
    if (r.sentAtMs !== null) {
      const late = r.sentAtMs - r.scheduledAtMs;
      this.h.lateness.record(late);
      if (late > this.lateThresholdMs) {
        this.lateSends++;
        if (phase) phase.a.lateSends++;
      }
    }
    if (r.dispatchedAtMs !== null) this.h.dispatchLag.record(r.dispatchedAtMs - r.scheduledAtMs);

    if (r.probe) {
      const p = (raw.probes[r.probe] ??= { planned: 0, denied: 0, allowed: 0, wrongStatus: 0, other: 0 });
      p.planned++;
      if (r.outcome === 'DENIED_AS_EXPECTED') p.denied++;
      else if (r.outcome === 'UNEXPECTEDLY_ALLOWED') p.allowed++;
      else if (r.outcome === 'PROBE_WRONG_STATUS') p.wrongStatus++;
      else p.other++;
    }

    this.tick(r.scheduledAtMs, 0);
    if (sent) this.tick(r.sentAtMs ?? r.dispatchedAtMs, 1);
    if (r.status !== null) this.tick(r.completedAtMs, 2);
    if (r.outcome !== 'OK' && r.outcome !== 'DENIED_AS_EXPECTED') this.tick(r.completedAtMs ?? r.scheduledAtMs, 3);

    if (position !== null && id) {
      this.perIdentity[position] = (this.perIdentity[position] ?? 0) + 1;
      if (sent) {
        const counter = r.probe ? this.negativeSent : this.positiveSent;
        counter[position] = (counter[position] ?? 0) + 1;
      }
      this.companiesUsed.add(id.companyId);
      const w = Math.floor(r.scheduledAtMs / 60_000);
      if (this.lastWindow[position] !== w) {
        this.lastWindow[position] = w;
        this.windows.set(w, (this.windows.get(w) ?? 0) + 1);
      }
    }
  }

  finish(planner: PlannerStats, generators: GeneratorEntry[]): RawAggregate {
    const byRole: RawAggregate['identities']['byRole'] = {};
    const byTier: RawAggregate['identities']['byTier'] = {};
    let used = 0;
    let max = 0;
    let requests = 0;
    this.identities.forEach((id, i) => {
      const n = this.perIdentity[i]!;
      for (const c of [(byRole[id.role] ??= emptyCohort()), (byTier[id.tier] ??= emptyCohort())]) {
        c.available++;
        if (n > 0) c.used++;
        c.requests += n;
        c.positive += this.positiveSent[i]!;
        c.negative += this.negativeSent[i]!;
      }
      if (n > 0) used++;
      requests += n;
      if (n > max) max = n;
    });
    return {
      ...structuredClone(this.raw),
      operations: Object.fromEntries([...this.ops.entries()].map(([k, v]) => [k, { ...v.a, latency: v.latency.toJSON(), service: v.service.toJSON() }])),
      histograms: {
        overall: this.h.overall.toJSON(),
        reads: this.h.reads.toJSON(),
        mutations: this.h.mutations.toJSON(),
        probes: this.h.probes.toJSON(),
        lateness: this.h.lateness.toJSON(),
        dispatchLag: this.h.dispatchLag.toJSON(),
        serviceOverall: this.h.serviceOverall.toJSON(),
        byCategory: histogramMapJSON(this.h.byCategory),
        byRole: histogramMapJSON(this.h.byRole),
        byTier: histogramMapJSON(this.h.byTier),
        byRegion: { [this.region]: { overall: this.regionHist.overall.toJSON(), reads: this.regionHist.reads.toJSON(), mutations: this.regionHist.mutations.toJSON() } },
      },
      phases: this.phases.map((p) => ({
        ...structuredClone(p.a),
        overall: p.overall.toJSON(),
        reads: p.reads.toJSON(),
        mutations: p.mutations.toJSON(),
        byOperation: Object.fromEntries([...p.byOperation.entries()].map(([k, v]) => [k, { kind: v.kind, latency: v.latency.toJSON() }])),
      })),
      timeline: [...this.timeline.entries()].sort((a, b) => a[0] - b[0]).map(([s, t]) => [s, ...t] as [number, number, number, number, number]),
      identities: {
        available: this.identities.length,
        used,
        maxPerIdentity: max,
        requests,
        windows: [...this.windows.entries()].sort((a, b) => a[0] - b[0]),
        byRole,
        byTier,
        companiesUsed: [...this.companiesUsed],
      },
      planner,
      generators,
    };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Merging (distributed generators: disjoint identity shards, one common start time)
// ---------------------------------------------------------------------------------------------------------------

const mergeHist = (a: SerializedHistogram, b: SerializedHistogram) => LogHistogram.from(a).merge(b).toJSON();
const mergeHistMap = (a: Record<string, SerializedHistogram>, b: Record<string, SerializedHistogram>) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = out[k] ? mergeHist(out[k]!, v) : v;
  return out;
};
const addCohorts = (into: Record<string, CohortCounts>, from: Record<string, CohortCounts>) => {
  for (const [k, v] of Object.entries(from)) {
    const o = (into[k] ??= emptyCohort());
    o.available += v.available;
    o.used += v.used;
    o.requests += v.requests;
    o.positive += v.positive;
    o.negative += v.negative;
  }
};

export function mergeAggregates(parts: readonly RawAggregate[]): RawAggregate {
  if (parts.length === 0) throw new Error('Nothing to merge');
  const [first, ...rest] = parts;
  const out: RawAggregate = structuredClone(first!);
  for (const p of rest) {
    out.offered += p.offered;
    out.sent += p.sent;
    out.completed += p.completed;
    addCounts(out.outcomes, p.outcomes);
    out.valid.offered += p.valid.offered;
    addCounts(out.valid.outcomes, p.valid.outcomes);
    out.inWindow.sent += p.inWindow.sent;
    out.inWindow.completed += p.inWindow.completed;
    addCounts(out.notSentReasons, p.notSentReasons);
    addCounts(out.statusCounts, p.statusCounts);
    addCounts(out.errorCodes, p.errorCodes);
    addCounts(out.deniedByCode, p.deniedByCode);
    for (const [k, v] of Object.entries(p.operations)) {
      const o = out.operations[k];
      if (!o) {
        out.operations[k] = structuredClone(v);
        continue;
      }
      o.offered += v.offered;
      o.sent += v.sent;
      o.completed += v.completed;
      addCounts(o.outcomes, v.outcomes);
      addCounts(o.statusCounts, v.statusCounts);
      o.latency = mergeHist(o.latency, v.latency);
      o.service = mergeHist(o.service, v.service);
    }
    const h = out.histograms;
    for (const k of ['overall', 'reads', 'mutations', 'probes', 'lateness', 'dispatchLag', 'serviceOverall'] as const) h[k] = mergeHist(h[k], p.histograms[k]);
    h.byCategory = mergeHistMap(h.byCategory, p.histograms.byCategory);
    h.byRole = mergeHistMap(h.byRole, p.histograms.byRole);
    h.byTier = mergeHistMap(h.byTier, p.histograms.byTier);
    for (const [k, v] of Object.entries(p.histograms.byRegion)) {
      const o = h.byRegion[k];
      h.byRegion[k] = o ? { overall: mergeHist(o.overall, v.overall), reads: mergeHist(o.reads, v.reads), mutations: mergeHist(o.mutations, v.mutations) } : structuredClone(v);
    }
    p.phases.forEach((ph, i) => {
      const o = out.phases[i];
      if (!o) {
        out.phases[i] = structuredClone(ph);
        return;
      }
      o.offered += ph.offered;
      o.sent += ph.sent;
      o.completed += ph.completed;
      o.lateSends += ph.lateSends;
      addCounts(o.outcomes, ph.outcomes);
      o.validOffered += ph.validOffered;
      addCounts(o.validOutcomes, ph.validOutcomes);
      o.overall = mergeHist(o.overall, ph.overall);
      o.reads = mergeHist(o.reads, ph.reads);
      o.mutations = mergeHist(o.mutations, ph.mutations);
      for (const [k, v] of Object.entries(ph.byOperation)) {
        const ov = o.byOperation[k];
        o.byOperation[k] = ov ? { kind: ov.kind, latency: mergeHist(ov.latency, v.latency) } : structuredClone(v);
      }
    });
    const tl = new Map(out.timeline.map((t) => [t[0], t]));
    for (const t of p.timeline) {
      const o = tl.get(t[0]);
      if (o) for (let i = 1; i < 5; i++) o[i]! += t[i]!;
      else tl.set(t[0], [...t]);
    }
    out.timeline = [...tl.values()].sort((a, b) => a[0] - b[0]);
    const id = out.identities;
    id.available += p.identities.available;
    id.used += p.identities.used;
    id.requests += p.identities.requests;
    id.maxPerIdentity = Math.max(id.maxPerIdentity, p.identities.maxPerIdentity);
    const w = new Map(id.windows);
    for (const [k, n] of p.identities.windows) w.set(k, (w.get(k) ?? 0) + n);
    id.windows = [...w.entries()].sort((a, b) => a[0] - b[0]);
    addCohorts(id.byRole, p.identities.byRole);
    addCohorts(id.byTier, p.identities.byTier);
    id.companiesUsed = [...new Set([...id.companiesUsed, ...p.identities.companiesUsed])];
    const pl = out.planner;
    addCounts(pl.offeredByCategory, p.planner.offeredByCategory);
    addCounts(pl.offeredByOperation, p.planner.offeredByOperation);
    addCounts(pl.notCovered, p.planner.notCovered);
    addCounts(pl.inventoryExhausted, p.planner.inventoryExhausted);
    addCounts(pl.unplannable, p.planner.unplannable);
    pl.probesPlanned += p.planner.probesPlanned;
    for (const [k, v] of Object.entries(p.probes)) {
      const o = (out.probes[k] ??= { planned: 0, denied: 0, allowed: 0, wrongStatus: 0, other: 0 });
      o.planned += v.planned;
      o.denied += v.denied;
      o.allowed += v.allowed;
      o.wrongStatus += v.wrongStatus;
      o.other += v.other;
    }
    out.generators.push(...p.generators);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// S03 thresholds, stages and gates
// ---------------------------------------------------------------------------------------------------------------

/** NFR-S03 limits for valid foreground work, measured per operation (not only in aggregate). */
export const S03 = { readP95Ms: 1000, readP99Ms: 3000, mutationP95Ms: 2000, mutationP99Ms: 5000, maxFailureRate: 0.0005 } as const;

export interface S03Check {
  name: string;
  value: number | null;
  limit: number;
  pass: boolean;
}

function s03Checks(
  ops: Record<string, { kind: 'read' | 'mutation'; probe?: string | null; latency: SerializedHistogram }>,
  reads: SerializedHistogram,
  mutations: SerializedHistogram,
  failures: number,
  validOffered: number,
  rejected: number,
  regions: Record<string, RegionHistograms> = {},
): S03Check[] {
  const checks: S03Check[] = [];
  const add = (name: string, value: number | null, limit: number) => checks.push({ name, value, limit, pass: value === null || value <= limit });
  const latencyChecks = (suffix: string, r: SerializedHistogram, m: SerializedHistogram) => {
    for (const [scope, kind, h] of [
      ['reads', 'read', r],
      ['mutations', 'mutation', m],
    ] as const) {
      const s = LogHistogram.from(h);
      if (s.count === 0) continue;
      add(`${scope} p95 ms${suffix}`, s.percentile(0.95), kind === 'read' ? S03.readP95Ms : S03.mutationP95Ms);
      add(`${scope} p99 ms${suffix}`, s.percentile(0.99), kind === 'read' ? S03.readP99Ms : S03.mutationP99Ms);
    }
  };
  latencyChecks('', reads, mutations);
  // "Thresholds hold by operation and serving region, not only aggregate average" (NFR-S03).
  const regionNames = Object.keys(regions).sort();
  if (regionNames.length > 1) for (const name of regionNames) latencyChecks(` (region ${name})`, regions[name]!.reads, regions[name]!.mutations);
  for (const [name, o] of Object.entries(ops).sort((a, b) => a[0].localeCompare(b[0]))) {
    if (o.probe) continue;
    const s = LogHistogram.from(o.latency);
    if (s.count === 0) continue;
    add(`${name} p95 ms`, s.percentile(0.95), o.kind === 'read' ? S03.readP95Ms : S03.mutationP95Ms);
    add(`${name} p99 ms`, s.percentile(0.99), o.kind === 'read' ? S03.readP99Ms : S03.mutationP99Ms);
  }
  add('unexpected timeout/5xx/throttle/non-response rate of offered valid requests', validOffered > 0 ? failures / validOffered : null, S03.maxFailureRate);
  // "Legitimate scripted actions cannot be silently omitted": a valid scripted request refused with a 4xx is a failure.
  add('valid scripted requests rejected (4xx)', rejected, 0);
  return checks;
}

export type StageName = 'harness-check' | 'single-unit' | '10k' | '100k' | '1m' | '5m' | '10m' | '10m-burst' | '10m-soak';

interface StageDef {
  label: string;
  identities?: number;
  offeredRps?: number;
  holdSeconds?: number;
  /** G4 fixes this hold (the full-scale runs): a declared hold may lengthen it, never shorten it. */
  fixedHold?: boolean;
}

/**
 * G4 stages. Rates follow G1 (one business request per active user every 10 s). The full-scale holds are G4's
 * (2 h nominal, 15 min burst, 24 h soak); G4 sets no hold for the intermediate stages, so they default to the
 * nominal 2 h and a test plan may declare another (recorded in the stage reasons).
 */
export const STAGES: Readonly<Record<StageName, StageDef>> = {
  'harness-check': { label: 'Harness mechanics check (not a G4 stage)' },
  'single-unit': { label: 'Single serving unit: saturation and safe limit (step-up phases)' },
  '10k': { label: '10,000 concurrent identities', identities: 10_000, offeredRps: 1_000, holdSeconds: 7_200 },
  '100k': { label: '100,000 concurrent identities', identities: 100_000, offeredRps: 10_000, holdSeconds: 7_200 },
  '1m': { label: '1 million concurrent identities', identities: 1_000_000, offeredRps: 100_000, holdSeconds: 7_200 },
  '5m': { label: '5 million concurrent identities', identities: 5_000_000, offeredRps: 500_000, holdSeconds: 7_200 },
  '10m': { label: '10 million concurrent identities, nominal 1,000,000 RPS for 2 h', identities: 10_000_000, offeredRps: 1_000_000, holdSeconds: 7_200, fixedHold: true },
  '10m-burst': { label: '10 million identities, burst 1,500,000 RPS for 15 min', identities: 10_000_000, offeredRps: 1_500_000, holdSeconds: 900, fixedHold: true },
  '10m-soak': { label: '10 million identities, nominal 24-hour soak', identities: 10_000_000, offeredRps: 1_000_000, holdSeconds: 86_400, fixedHold: true },
};

/** The hold a stage is judged on: the declared one, except that a G4-fixed hold is never shortened. */
export function stageHold(stage: StageName, declared: number | undefined): { seconds: number | null; ignoredDeclared: boolean } {
  const def = STAGES[stage];
  if (def.fixedHold && def.holdSeconds !== undefined && declared !== undefined && declared < def.holdSeconds) return { seconds: def.holdSeconds, ignoredDeclared: true };
  return { seconds: declared ?? def.holdSeconds ?? null, ignoredDeclared: false };
}

export const NO_CAPACITY_CLAIM =
  'No capacity claim. This report records one run of the workload harness. Under BRD v8.2 G5 no capacity is claimed from arithmetic, ' +
  'architecture prose or a small run; ZT31-ZT35 pass only on full-scale G4 evidence reviewed by the platform lead, senior developer and QA, ' +
  'and intermediate stage results guide tuning and funding but are never a ten-million-user pass.';

/**
 * A stage's hold: the longest run of consecutive phases scheduled at or above `minRate` (a ramp before it and a
 * recovery phase after it are allowed), as seconds from the start of the schedule and the phase indexes it covers.
 */
export function holdSpan(phases: readonly Phase[], minRate: number): { startSeconds: number; endSeconds: number; phases: number[] } | null {
  type Span = { startSeconds: number; endSeconds: number; phases: number[] };
  let best: Span | null = null;
  let current: Span | null = null;
  let t = 0;
  for (let i = 0; i < phases.length; i++) {
    const p = phases[i]!;
    if (p.ratePerSecond >= minRate) {
      if (current === null) current = { startSeconds: t, endSeconds: t, phases: [] };
      current.endSeconds = t + p.durationSeconds;
      current.phases.push(i);
      if (best === null || current.endSeconds - current.startSeconds > best.endSeconds - best.startSeconds) best = { ...current, phases: [...current.phases] };
    } else {
      current = null;
    }
    t += p.durationSeconds;
  }
  return best;
}

// ---------------------------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------------------------

/** The static part of the report's fixture section (from the manifest; carried unchanged through merges). */
export interface FixtureSummary {
  fixtureId: string;
  createdAt: string;
  rotatedAt: string | null;
  businessDate: string;
  identitiesInFixture: number;
  companies: number;
  companySkew: { index: number; tier: string; targetShare: number; identities: number }[];
  roleTotals: Record<string, number>;
  roleTargetShares: Record<string, number>;
  counts: Record<string, number>;
  inventory: FixtureManifest['inventory'];
  schemaMigrations: string[];
  schemaFingerprint: string;
  warnings: string[];
}

export function summarizeFixture(m: FixtureManifest): FixtureSummary {
  return {
    fixtureId: m.fixtureId,
    createdAt: m.createdAt,
    rotatedAt: m.rotatedAt,
    businessDate: m.businessDate,
    identitiesInFixture: m.identityCount,
    companies: m.companies.length,
    // The hot company, the large tier and the first tail companies show the G2 skew.
    companySkew: m.companies.slice(0, 12).map((c) => ({ index: c.index, tier: c.tier, targetShare: round3(c.targetShare), identities: c.identities })),
    roleTotals: m.roleTotals,
    roleTargetShares: m.roleTargetShares,
    counts: m.counts,
    inventory: m.inventory,
    schemaMigrations: m.schemaMigrations,
    schemaFingerprint: m.schemaFingerprint,
    warnings: m.warnings,
  };
}

export interface RunContext {
  runId: string;
  stage: StageName;
  /** A declared hold for the stage when the test plan states one (recorded in the report); defaults to STAGES. */
  stageHoldSeconds?: number;
  profile: string;
  profileShares: Readonly<Record<Category, number>>;
  arrival: 'uniform' | 'poisson';
  mixSelection: 'deficit' | 'random';
  seed: number;
  phases: Phase[];
  timeoutMs: number;
  maxInFlight: number;
  negativeShare: number;
  target: string;
  startedAt: string;
  startEpochMs: number;
  finishedAt: string;
  drainSeconds: number;
  labels: { build: string | null; topology: string | null; notes: string | null };
  shardCount: number;
  merged: boolean;
  mergedFrom: string[];
  records: { kept: number; truncated: boolean; file: string | null };
  fixture: FixtureSummary;
  inventoryCheck: { op: string; expected: number; available: number }[];
}

export interface LoadReport {
  schema: typeof REPORT_SCHEMA;
  run: {
    id: string;
    stage: StageName;
    profile: string;
    arrival: string;
    mixSelection: string;
    seed: number;
    phases: Phase[];
    scheduleSeconds: number;
    drainSeconds: number;
    timeoutMs: number;
    maxInFlight: number;
    negativeShare: number;
    target: string;
    startedAt: string;
    startEpochMs: number;
    finishedAt: string;
    generators: number;
    shardCount: number;
    merged: boolean;
    mergedFrom: string[];
  };
  environment: { harnessVersion: string; node: string; platform: string; arch: string; build: string | null; topology: string | null; notes: string | null };
  fixture: FixtureSummary & {
    inventoryCheck: { op: string; expected: number; available: number }[];
    sufficient: boolean;
    reasons: string[];
  };
  totals: {
    offered: number;
    /** Offered arrivals that were not negative probes (NFR-S03's denominator). */
    validOffered: number;
    sent: number;
    completed: number;
    notSent: number;
    ok: number;
    deniedAsExpected: number;
    unexpectedlyAllowed: number;
    identityMismatches: number;
    probeWrongStatus: number;
    rejected4xx: number;
    throttled429: number;
    serverErrors5xx: number;
    timeouts: number;
    networkErrors: number;
    droppedByGenerator: number;
    unplannable: number;
    s03Failures: number;
    s03FailureRate: number | null;
    integrityFailures: number;
  };
  /**
   * Rates over the scheduled window: offered = arrivals scheduled in it; sent and completed = sends and completions
   * that happened inside it. A generator that falls behind sends after the window; a slow system completes after it.
   */
  rates: {
    windowSeconds: number;
    offeredPerSecond: number;
    sentPerSecond: number;
    completedPerSecond: number;
    sentAfterWindow: number;
    completedAfterWindow: number;
    drainSeconds: number;
  };
  latency: {
    basis: 'scheduled-time';
    overall: LatencySummary;
    reads: LatencySummary;
    mutations: LatencySummary;
    probes: LatencySummary;
    byCategory: Record<string, LatencySummary>;
    byOperation: Record<string, LatencySummary>;
    byRole: Record<string, LatencySummary>;
    byTier: Record<string, LatencySummary>;
    byRegion: Record<string, { overall: LatencySummary; reads: LatencySummary; mutations: LatencySummary }>;
  };
  serviceTime: { basis: 'actual-send-time'; overall: LatencySummary; byOperation: Record<string, LatencySummary> };
  statusCounts: Record<string, number>;
  errorCodes: Record<string, number>;
  operations: Record<string, { category: string; kind: string; probe: string | null; offered: number; sent: number; completed: number; outcomes: Record<string, number>; statusCounts: Record<string, number> }>;
  mix: {
    target: Record<string, number>;
    actual: Record<string, number>;
    labels: Record<string, string>;
    offeredByCategory: Record<string, number>;
    offeredByOperation: Record<string, number>;
    notCovered: Record<string, number>;
    inventoryExhausted: Record<string, number>;
    unplannable: Record<string, number>;
  };
  identities: {
    available: number;
    distinctUsed: number;
    maxRequestsPerIdentity: number;
    meanRequestsPerUsedIdentity: number | null;
    meanRequestIntervalSeconds: number | null;
    activePerMinute: { completeWindows: number; min: number | null; max: number | null; mean: number | null };
    companiesUsed: number;
    byRole: Record<string, CohortCounts>;
    byTier: Record<string, CohortCounts>;
    /** G2: every role of the fixture issues positive and negative protected requests. */
    roleCoverage: { roles: string[]; withoutPositive: string[]; withoutNegative: string[] };
  };
  negative: {
    planned: number;
    deniedAsExpected: number;
    unexpectedlyAllowed: number;
    wrongStatus: number;
    byKind: RawAggregate['probes'];
    deniedByCode: Record<string, number>;
  };
  phases: {
    index: number;
    ratePerSecond: number;
    durationSeconds: number;
    offered: number;
    validOffered: number;
    sent: number;
    completed: number;
    lateSends: number;
    latency: { overall: LatencySummary; reads: LatencySummary; mutations: LatencySummary };
    s03: { pass: boolean; failed: string[] };
  }[];
  timeline: { startEpochMs: number; columns: ['second', 'offered', 'sent', 'completed', 'failures']; rows: [number, number, number, number, number][] };
  generator: {
    healthy: boolean;
    reasons: string[];
    lateSends: number;
    lateFraction: number;
    lateness: LatencySummary;
    dispatchLag: LatencySummary;
    droppedByGenerator: number;
    perGenerator: GeneratorEntry[];
  };
  s03: { limits: typeof S03; pass: boolean; checks: S03Check[] };
  verdict: {
    run: Verdict;
    runReasons: string[];
    stage: { name: StageName; label: string; verdict: Verdict; reasons: string[]; required: StageDef; achieved: Record<string, number | null> };
    gates: { id: string; title: string; verdict: Verdict; reasons: string[] }[];
    claim: string;
  };
  records: { kept: number; truncated: boolean; file: string | null };
  raw: RawAggregate;
}

const summaryOf = (h: SerializedHistogram) => LogHistogram.from(h).summary();
const summaries = (m: Record<string, SerializedHistogram>) =>
  Object.fromEntries(Object.entries(m).sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => [k, summaryOf(v)]));

export function buildReport(raw: RawAggregate, ctx: RunContext): LoadReport {
  const scheduleSeconds = ctx.phases.reduce((n, p) => n + p.durationSeconds, 0);
  const o = raw.outcomes;
  const n = (k: Outcome) => o[k] ?? 0;
  // The S03 error budget counts valid requests only: negative probes are expected to be refused.
  const s03Failures = S03_FAILURES.reduce((t, k) => t + (raw.valid.outcomes[k] ?? 0), 0);
  const integrityFailures = INTEGRITY_FAILURES.reduce((t, k) => t + n(k), 0);
  const totals: LoadReport['totals'] = {
    offered: raw.offered,
    validOffered: raw.valid.offered,
    sent: raw.sent,
    completed: raw.completed,
    notSent: n('NOT_SENT'),
    ok: n('OK'),
    deniedAsExpected: n('DENIED_AS_EXPECTED'),
    unexpectedlyAllowed: n('UNEXPECTEDLY_ALLOWED'),
    identityMismatches: n('IDENTITY_MISMATCH'),
    probeWrongStatus: n('PROBE_WRONG_STATUS'),
    rejected4xx: n('REJECTED'),
    throttled429: n('THROTTLED'),
    serverErrors5xx: Object.entries(raw.statusCounts).reduce((t, [s, c]) => t + (Number(s) >= 500 ? c : 0), 0),
    timeouts: n('TIMEOUT'),
    networkErrors: n('NETWORK_ERROR'),
    droppedByGenerator: raw.notSentReasons.GENERATOR_IN_FLIGHT_LIMIT ?? 0,
    unplannable: raw.notSentReasons.NO_ELIGIBLE_IDENTITY ?? 0,
    s03Failures,
    s03FailureRate: raw.valid.offered > 0 ? s03Failures / raw.valid.offered : null,
    integrityFailures,
  };
  const per = (v: number) => (scheduleSeconds > 0 ? round3(v / scheduleSeconds) : 0);

  // Generator health: every generator must be healthy.
  const lateSends = raw.generators.reduce((t, g) => t + g.measurements.lateSends, 0);
  const genReasons = raw.generators.flatMap((g) => (raw.generators.length > 1 ? g.reasons.map((r) => `${g.generatorId}: ${r}`) : g.reasons));
  const healthy = raw.generators.length > 0 && raw.generators.every((g) => g.healthy);
  if (raw.generators.length === 0) genReasons.push('no generator health was recorded');

  // Fixture sufficiency: the mix must be served by valid fixture states.
  const fixtureReasons: string[] = [];
  const exhausted = Object.values(raw.planner.inventoryExhausted).reduce((t, v) => t + v, 0);
  if (exhausted > 0) {
    fixtureReasons.push(
      `fixture inventory ran out (${Object.entries(raw.planner.inventoryExhausted).map(([k, v]) => `${k} ${v}`).join(', ')}): those arrivals were sent as other operations of their category; regenerate a larger fixture or restore its snapshot`,
    );
  }
  if (totals.unplannable > 0) fixtureReasons.push(`${totals.unplannable} arrivals had no eligible fixture identity in their category and were not sent`);
  for (const i of ctx.inventoryCheck) {
    if (i.expected > i.available) fixtureReasons.push(`planned ${i.op} needs about ${i.expected} fixture states, the fixture holds ${i.available}`);
  }
  // A probe denied with an unexpected 4xx is not a leak, but the probe did not test what it claims: review it.
  const probeReasons: string[] = [];
  if (totals.probeWrongStatus > 0) {
    const wrong = Object.entries(raw.probes).filter(([, p]) => p.wrongStatus > 0).map(([k, p]) => `${k} ${p.wrongStatus}`);
    probeReasons.push(`negative probes answered with an unexpected status (${wrong.join(', ')}): the probe definitions need review`);
  }

  // S03 per operation, per region and overall; per phase for step-up runs (cohort results, not pooled averages).
  const checks = s03Checks(raw.operations, raw.histograms.reads, raw.histograms.mutations, s03Failures, raw.valid.offered, totals.rejected4xx, raw.histograms.byRegion);
  const s03Pass = checks.every((c) => c.pass);
  const empty = () => summaryOf(new LogHistogram().toJSON());
  const phases: LoadReport['phases'] = ctx.phases.map((p, i) => {
    const a = raw.phases[i];
    if (!a) {
      return { index: i, ...p, offered: 0, validOffered: 0, sent: 0, completed: 0, lateSends: 0, latency: { overall: empty(), reads: empty(), mutations: empty() }, s03: { pass: false, failed: ['no data'] } };
    }
    const pf = S03_FAILURES.reduce((t, k) => t + (a.validOutcomes[k] ?? 0), 0);
    const pc = s03Checks(a.byOperation, a.reads, a.mutations, pf, a.validOffered, a.validOutcomes.REJECTED ?? 0);
    return {
      index: i,
      ratePerSecond: p.ratePerSecond,
      durationSeconds: p.durationSeconds,
      offered: a.offered,
      validOffered: a.validOffered,
      sent: a.sent,
      completed: a.completed,
      lateSends: a.lateSends,
      latency: { overall: summaryOf(a.overall), reads: summaryOf(a.reads), mutations: summaryOf(a.mutations) },
      s03: { pass: pc.every((c) => c.pass) && (a.outcomes.UNEXPECTEDLY_ALLOWED ?? 0) + (a.outcomes.IDENTITY_MISMATCH ?? 0) === 0, failed: pc.filter((c) => !c.pass).map((c) => `${c.name} ${c.value} > ${c.limit}`) },
    };
  });

  // Run verdict.
  const runReasons: string[] = [];
  let run: Verdict;
  if (integrityFailures > 0) {
    run = 'FAIL';
    runReasons.push(`${integrityFailures} integrity failure(s): ${totals.unexpectedlyAllowed} probe(s) unexpectedly allowed, ${totals.identityMismatches} response(s) for the wrong identity (zero tolerance)`);
  } else if (!healthy || fixtureReasons.length > 0 || probeReasons.length > 0) {
    run = 'BLOCKED';
    runReasons.push(...genReasons.map((r) => `generator: ${r}`), ...fixtureReasons.map((r) => `fixture: ${r}`), ...probeReasons.map((r) => `harness: ${r}`));
    if (!s03Pass && raw.offered > 0) runReasons.push('S03 limits were also missed, but a blocked run measures nothing reliable');
  } else if (raw.offered === 0) {
    run = 'BLOCKED';
    runReasons.push('nothing was offered');
  } else if (!s03Pass) {
    run = 'FAIL';
    runReasons.push(...checks.filter((c) => !c.pass).map((c) => `S03: ${c.name} ${c.value} exceeds ${c.limit}`));
  } else {
    run = 'PASS';
    runReasons.push(
      `S03 latency and error limits met at this run's own offered load (${per(raw.offered)} RPS, ${raw.identities.used} identities); a run verdict is not stage or gate evidence and makes no capacity claim`,
    );
  }

  // Identity activity (G1: concurrency = distinct identities active at the same time).
  const completeWindows = raw.identities.windows.filter(([k]) => (k + 1) * 60 <= scheduleSeconds);
  const winCounts = completeWindows.map(([, c]) => c);
  const activeMin = winCounts.length ? Math.min(...winCounts) : null;
  const offeredRate = per(raw.offered);

  // G2 role coverage: every role present in the fixture issues positive and negative protected requests.
  const roles = Object.entries(raw.identities.byRole).filter(([, c]) => c.available > 0).map(([k]) => k).sort();
  const roleCoverage = {
    roles,
    withoutPositive: roles.filter((r) => raw.identities.byRole[r]!.positive === 0),
    withoutNegative: roles.filter((r) => raw.identities.byRole[r]!.negative === 0),
  };

  // Stage verdict. A stage is judged on its hold: the longest run of consecutive phases at the stage rate (a ramp
  // before it and a recovery phase after it are allowed), with the stage's identities active in every full minute.
  const stageDef = STAGES[ctx.stage];
  const { seconds: hold, ignoredDeclared } = stageHold(ctx.stage, ctx.stageHoldSeconds);
  const stageReasons: string[] = [];
  let stageVerdict: Verdict;
  const span = stageDef.offeredRps !== undefined ? holdSpan(ctx.phases, stageDef.offeredRps * RATE_TOLERANCE) : null;
  const spanSeconds = span ? span.endSeconds - span.startSeconds : 0;
  const spanValidOffered = span ? span.phases.reduce((t, i) => t + (raw.phases[i]?.validOffered ?? 0), 0) : 0;
  const spanWindows = span ? raw.identities.windows.filter(([k]) => k * 60 >= span.startSeconds && (k + 1) * 60 <= span.endSeconds).map(([, c]) => c) : [];
  const rateStage = stageDef.offeredRps !== undefined;
  const achieved: Record<string, number | null> = {
    distinctIdentities: raw.identities.used,
    minActiveIdentitiesPerMinute: rateStage ? (spanWindows.length ? Math.min(...spanWindows) : null) : activeMin,
    // Business requests: negative probes are offered on top of the stage rate.
    offeredValidPerSecond: rateStage ? (spanSeconds > 0 ? round3(spanValidOffered / spanSeconds) : 0) : per(raw.valid.offered),
    longestHoldSeconds: rateStage ? spanSeconds : scheduleSeconds,
  };
  if (ctx.stage === 'harness-check') {
    stageVerdict = 'BLOCKED';
    stageReasons.push('a harness check proves only that the harness works; it is not G4 stage evidence');
  } else if (ctx.shardCount > 1 && !ctx.merged) {
    stageVerdict = 'BLOCKED';
    stageReasons.push(`this is one shard of a ${ctx.shardCount}-generator run: merge every shard report (generator.ts merge) before judging the stage`);
  } else if (run === 'FAIL' && integrityFailures > 0) {
    stageVerdict = 'FAIL';
    stageReasons.push('integrity failure under load');
  } else if (run === 'BLOCKED') {
    stageVerdict = 'BLOCKED';
    stageReasons.push('the run is blocked (generator or fixture)');
  } else if (ctx.stage === 'single-unit') {
    const firstFail = phases.findIndex((p) => !p.s03.pass);
    const passing = (firstFail < 0 ? phases : phases.slice(0, firstFail)).filter((p) => p.s03.pass);
    achieved.safeLimitCandidateRps = passing.length ? Math.max(...passing.map((p) => p.ratePerSecond)) : null;
    achieved.firstFailingStepRps = firstFail >= 0 ? phases[firstFail]!.ratePerSecond : null;
    if (phases.length < 2) {
      stageVerdict = 'BLOCKED';
      stageReasons.push('a saturation test needs a step-up of at least two phases');
    } else if (firstFail < 0) {
      stageVerdict = 'BLOCKED';
      stageReasons.push('every step met S03: saturation was not reached; extend the step-up');
    } else if (passing.length === 0) {
      stageVerdict = 'BLOCKED';
      stageReasons.push('the first step already missed S03: start the step-up lower');
    } else {
      stageVerdict = 'PASS';
      stageReasons.push(
        `safe-limit candidate ${achieved.safeLimitCandidateRps} RPS for this serving unit (first failing step ${achieved.firstFailingStepRps} RPS), measured on the recorded topology only; it needs review and says nothing about other topologies`,
      );
    }
  } else {
    const shortfalls: string[] = [];
    const active = achieved.minActiveIdentitiesPerMinute ?? null;
    if (raw.identities.used < stageDef.identities!) shortfalls.push(`distinct identities ${raw.identities.used} < ${stageDef.identities}`);
    if (active === null || active < stageDef.identities!) shortfalls.push(`identities active in every full minute of the hold ${active ?? 'n/a'} < ${stageDef.identities}`);
    if ((achieved.offeredValidPerSecond ?? 0) < stageDef.offeredRps! * RATE_TOLERANCE) {
      shortfalls.push(`offered ${achieved.offeredValidPerSecond} valid RPS during the hold < ${stageDef.offeredRps} RPS (negative probes come on top)`);
    }
    if ((achieved.longestHoldSeconds ?? 0) < (hold ?? 0)) shortfalls.push(`held ${achieved.longestHoldSeconds} s at the stage rate < ${hold} s`);
    if (roleCoverage.withoutPositive.length) shortfalls.push(`roles without positive requests: ${roleCoverage.withoutPositive.join(', ')}`);
    if (roleCoverage.withoutNegative.length) shortfalls.push(`roles without negative requests: ${roleCoverage.withoutNegative.join(', ')}`);
    if (shortfalls.length) {
      stageVerdict = 'BLOCKED';
      stageReasons.push(`the run did not reach the stage definition: ${shortfalls.join('; ')}`);
      if (run === 'FAIL') stageReasons.push('S03 limits were already missed below the stage definition');
    } else if (run === 'FAIL') {
      stageVerdict = 'FAIL';
      stageReasons.push('S03 limits missed at the stage load');
    } else {
      stageVerdict = 'PASS';
      stageReasons.push('stage load reached and S03 met for this run; the stage result still needs review with the server-side evidence (G4 report contents)');
    }
  }
  if (ignoredDeclared) {
    stageReasons.push(`declared hold ${ctx.stageHoldSeconds} s ignored: G4 fixes this stage's hold at ${stageDef.holdSeconds} s`);
  } else if (ctx.stageHoldSeconds !== undefined && stageDef.holdSeconds !== undefined && ctx.stageHoldSeconds !== stageDef.holdSeconds) {
    stageReasons.push(`declared hold ${ctx.stageHoldSeconds} s used instead of the default ${stageDef.holdSeconds} s`);
  }

  // Gates: a single run never passes a gate (they need full-scale, multi-run, reviewed evidence).
  const fullNominal = ctx.stage === '10m' && stageVerdict === 'PASS';
  const fullBurst = ctx.stage === '10m-burst' && stageVerdict === 'PASS';
  const probeFails = totals.unexpectedlyAllowed > 0;
  const gate = (id: string, title: string, failIf: string | null, blocked: string[]) => ({
    id,
    title,
    verdict: (failIf ? 'FAIL' : 'BLOCKED') as Verdict,
    reasons: failIf ? [failIf] : blocked,
  });
  const fullScaleFail = (stage: StageName) => (ctx.stage === stage && stageVerdict === 'FAIL' ? `the ${stage} stage run failed` : null);
  const gates = [
    gate('ZT31', 'Concurrent capacity and burst', fullScaleFail('10m') ?? fullScaleFail('10m-burst'), [
      fullNominal ? 'nominal 2-hour evidence from this run is present' : 'needs 10,000,000 distinct identities at 1,000,000 offered RPS for 2 hours (a G4 10m run)',
      fullBurst ? 'burst evidence from this run is present' : 'needs a separate 15-minute 1,500,000 RPS burst run',
      'a gate is decided by review of the combined full-scale evidence, never by one run',
    ]),
    gate('ZT32', 'Login and permission correctness at scale', probeFails ? `${totals.unexpectedlyAllowed} negative probe(s) were allowed under load` : null, [
      'needs 10,000,000 distinct login flows over 10 minutes plus MFA through the production identity provider (T-03); pre-issued development tokens are not authentication proof (NFR-S04)',
      `negative probes in this run: ${totals.deniedAsExpected} denied as expected, 0 allowed`,
    ]),
    gate('ZT33', 'Partition and transaction integrity', totals.identityMismatches > 0 ? `${totals.identityMismatches} response(s) belonged to another identity` : probeFails ? 'a protected action was allowed outside its scope' : null, [
      'needs hot-company, shard/cell movement, replica lag and concurrent-decision scenarios with reconciliation at full scale',
    ]),
    gate('ZT34', 'Failure recovery and soak', fullScaleFail('10m-soak'), [
      'needs a zone-loss test at nominal traffic, regional failover within 15 minutes, restore reconciliation and a 24-hour nominal soak',
    ]),
    gate('ZT35', 'Capacity evidence and safe rollout', null, [
      'needs reviewed per-unit and global capacity, dependency quotas, saturation/queue metrics, topology/cost plan and staged rollback',
      ...(healthy ? [] : ['this run was generator-limited, so its capacity remains blocked']),
    ]),
  ];

  const opsOut: LoadReport['operations'] = {};
  const latencyByOp: Record<string, LatencySummary> = {};
  const serviceByOp: Record<string, LatencySummary> = {};
  for (const [k, v] of Object.entries(raw.operations).sort((a, b) => a[0].localeCompare(b[0]))) {
    opsOut[k] = { category: v.category, kind: v.kind, probe: v.probe, offered: v.offered, sent: v.sent, completed: v.completed, outcomes: v.outcomes, statusCounts: v.statusCounts };
    latencyByOp[k] = summaryOf(v.latency);
    serviceByOp[k] = summaryOf(v.service);
  }
  const offeredByCategory = Object.fromEntries(CATEGORIES.map((c) => [c, raw.planner.offeredByCategory[c] ?? 0]));
  const plannedTotal = Object.values(offeredByCategory).reduce((t, v) => t + v, 0);
  const probeTotals = Object.values(raw.probes).reduce(
    (t, p) => ({ planned: t.planned + p.planned, denied: t.denied + p.denied, allowed: t.allowed + p.allowed, wrong: t.wrong + p.wrongStatus }),
    { planned: 0, denied: 0, allowed: 0, wrong: 0 },
  );
  const genAll = raw.generators;

  return {
    schema: REPORT_SCHEMA,
    run: {
      id: ctx.runId,
      stage: ctx.stage,
      profile: ctx.profile,
      arrival: ctx.arrival,
      mixSelection: ctx.mixSelection,
      seed: ctx.seed,
      phases: ctx.phases,
      scheduleSeconds,
      drainSeconds: ctx.drainSeconds,
      timeoutMs: ctx.timeoutMs,
      maxInFlight: ctx.maxInFlight,
      negativeShare: ctx.negativeShare,
      target: ctx.target,
      startedAt: ctx.startedAt,
      startEpochMs: ctx.startEpochMs,
      finishedAt: ctx.finishedAt,
      generators: genAll.length,
      shardCount: ctx.shardCount,
      merged: ctx.merged,
      mergedFrom: ctx.mergedFrom,
    },
    environment: { harnessVersion: HARNESS_VERSION, node: process.version, platform: process.platform, arch: process.arch, ...ctx.labels },
    fixture: { ...ctx.fixture, inventoryCheck: ctx.inventoryCheck, sufficient: fixtureReasons.length === 0, reasons: fixtureReasons },
    totals,
    rates: {
      windowSeconds: scheduleSeconds,
      offeredPerSecond: per(raw.offered),
      sentPerSecond: per(raw.inWindow.sent),
      completedPerSecond: per(raw.inWindow.completed),
      sentAfterWindow: raw.sent - raw.inWindow.sent,
      completedAfterWindow: raw.completed - raw.inWindow.completed,
      drainSeconds: ctx.drainSeconds,
    },
    latency: {
      basis: 'scheduled-time',
      overall: summaryOf(raw.histograms.overall),
      reads: summaryOf(raw.histograms.reads),
      mutations: summaryOf(raw.histograms.mutations),
      probes: summaryOf(raw.histograms.probes),
      byCategory: summaries(raw.histograms.byCategory),
      byOperation: latencyByOp,
      byRole: summaries(raw.histograms.byRole),
      byTier: summaries(raw.histograms.byTier),
      byRegion: Object.fromEntries(
        Object.entries(raw.histograms.byRegion)
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([k, v]) => [k, { overall: summaryOf(v.overall), reads: summaryOf(v.reads), mutations: summaryOf(v.mutations) }]),
      ),
    },
    serviceTime: { basis: 'actual-send-time', overall: summaryOf(raw.histograms.serviceOverall), byOperation: serviceByOp },
    statusCounts: raw.statusCounts,
    errorCodes: raw.errorCodes,
    operations: opsOut,
    mix: {
      target: { ...ctx.profileShares },
      actual: Object.fromEntries(CATEGORIES.map((c) => [c, plannedTotal > 0 ? round3((offeredByCategory[c] ?? 0) / plannedTotal) : 0])),
      labels: { ...CATEGORY_LABELS },
      offeredByCategory,
      offeredByOperation: raw.planner.offeredByOperation,
      notCovered: raw.planner.notCovered,
      inventoryExhausted: raw.planner.inventoryExhausted,
      unplannable: raw.planner.unplannable,
    },
    identities: {
      available: raw.identities.available,
      distinctUsed: raw.identities.used,
      maxRequestsPerIdentity: raw.identities.maxPerIdentity,
      meanRequestsPerUsedIdentity: raw.identities.used ? round3(raw.identities.requests / raw.identities.used) : null,
      meanRequestIntervalSeconds: offeredRate > 0 ? round3(raw.identities.used / offeredRate) : null,
      activePerMinute: {
        completeWindows: winCounts.length,
        min: activeMin,
        max: winCounts.length ? Math.max(...winCounts) : null,
        mean: winCounts.length ? round3(winCounts.reduce((t, v) => t + v, 0) / winCounts.length) : null,
      },
      companiesUsed: raw.identities.companiesUsed.length,
      byRole: raw.identities.byRole,
      byTier: raw.identities.byTier,
      roleCoverage,
    },
    negative: {
      planned: probeTotals.planned,
      deniedAsExpected: probeTotals.denied,
      unexpectedlyAllowed: probeTotals.allowed,
      wrongStatus: probeTotals.wrong,
      byKind: raw.probes,
      deniedByCode: raw.deniedByCode,
    },
    phases,
    timeline: { startEpochMs: ctx.startEpochMs, columns: ['second', 'offered', 'sent', 'completed', 'failures'], rows: raw.timeline },
    generator: {
      healthy,
      reasons: genReasons,
      lateSends,
      lateFraction: raw.sent > 0 ? round3(lateSends / raw.sent) : 0,
      lateness: summaryOf(raw.histograms.lateness),
      dispatchLag: summaryOf(raw.histograms.dispatchLag),
      droppedByGenerator: totals.droppedByGenerator,
      perGenerator: genAll,
    },
    s03: { limits: S03, pass: s03Pass, checks },
    verdict: {
      run,
      runReasons,
      stage: { name: ctx.stage, label: stageDef.label, verdict: stageVerdict, reasons: stageReasons, required: { ...stageDef, ...(hold !== null ? { holdSeconds: hold } : {}) }, achieved },
      gates,
      claim: NO_CAPACITY_CLAIM,
    },
    records: ctx.records,
    raw,
  };
}

/** Assesses one generator's measurements into its health entry. */
export function generatorEntry(
  meta: { generatorId: string; region: string | null; shard: { index: number; count: number }; startEpochMs: number },
  measurements: GeneratorMeasurements,
  thresholds: HealthThresholds,
): GeneratorEntry {
  const { healthy, reasons } = assessGeneratorHealth(measurements, thresholds);
  return { ...meta, healthy, reasons, thresholds, measurements };
}

// ---------------------------------------------------------------------------------------------------------------
// Validation and text summary
// ---------------------------------------------------------------------------------------------------------------

/** Every field a report must carry (dotted paths); see G4's list of test report contents. */
export const REPORT_FIELDS: readonly string[] = [
  'schema',
  'run.id',
  'run.stage',
  'run.profile',
  'run.arrival',
  'run.phases',
  'run.scheduleSeconds',
  'run.timeoutMs',
  'run.target',
  'run.startedAt',
  'run.shardCount',
  'environment.harnessVersion',
  'environment.node',
  'environment.build',
  'environment.topology',
  'fixture.fixtureId',
  'fixture.identitiesInFixture',
  'fixture.companySkew',
  'fixture.roleTotals',
  'fixture.counts',
  'fixture.schemaMigrations',
  'fixture.schemaFingerprint',
  'fixture.sufficient',
  'totals.offered',
  'totals.validOffered',
  'totals.sent',
  'totals.completed',
  'totals.notSent',
  'totals.ok',
  'totals.timeouts',
  'totals.serverErrors5xx',
  'totals.throttled429',
  'totals.rejected4xx',
  'totals.networkErrors',
  'totals.droppedByGenerator',
  'totals.s03FailureRate',
  'totals.integrityFailures',
  'rates.offeredPerSecond',
  'rates.sentPerSecond',
  'rates.completedPerSecond',
  'rates.sentAfterWindow',
  'rates.completedAfterWindow',
  'latency.basis',
  'latency.overall.p50',
  'latency.overall.p95',
  'latency.overall.p99',
  'latency.reads',
  'latency.mutations',
  'latency.byOperation',
  'latency.byRole',
  'latency.byTier',
  'latency.byRegion',
  'serviceTime.overall',
  'statusCounts',
  'errorCodes',
  'operations',
  'mix.target',
  'mix.actual',
  'identities.distinctUsed',
  'identities.activePerMinute',
  'identities.byRole',
  'identities.byTier',
  'identities.roleCoverage',
  'negative.planned',
  'negative.unexpectedlyAllowed',
  'negative.deniedByCode',
  'phases',
  'timeline.rows',
  'generator.healthy',
  'generator.reasons',
  'generator.lateness',
  'generator.lateFraction',
  'generator.droppedByGenerator',
  'generator.perGenerator',
  's03.checks',
  'verdict.run',
  'verdict.runReasons',
  'verdict.stage.verdict',
  'verdict.gates',
  'verdict.claim',
  'raw',
];

export function missingReportFields(report: unknown): string[] {
  return REPORT_FIELDS.filter((path) => {
    let v: unknown = report;
    for (const key of path.split('.')) {
      if (typeof v !== 'object' || v === null || !(key in v)) return true;
      v = (v as Record<string, unknown>)[key];
    }
    return v === undefined;
  });
}

const f = (v: number | null | undefined, unit = '') => (v === null || v === undefined ? 'n/a' : `${v}${unit}`);
const p95s = (m: Record<string, LatencySummary>) =>
  Object.entries(m)
    .map(([k, s]) => `${k} ${f(s.p95)}`)
    .join(', ') || 'n/a';

export function formatSummary(r: LoadReport): string {
  const lines: string[] = [];
  const t = r.totals;
  lines.push(`HRMS load run ${r.run.id} - stage ${r.run.stage}, profile ${r.run.profile}, ${r.run.arrival} arrivals${r.run.merged ? `, merged from ${r.run.mergedFrom.length} reports` : ''}`);
  lines.push(`Run verdict: ${r.verdict.run}`);
  for (const reason of r.verdict.runReasons) lines.push(`  - ${reason}`);
  lines.push(`Stage verdict (${r.verdict.stage.label}): ${r.verdict.stage.verdict}`);
  for (const reason of r.verdict.stage.reasons) lines.push(`  - ${reason}`);
  lines.push(`Gates: ${r.verdict.gates.map((g) => `${g.id} ${g.verdict}`).join(', ')}`);
  lines.push('');
  lines.push(
    `Schedule: ${r.run.phases.map((p) => `${p.ratePerSecond}/s x ${p.durationSeconds}s`).join(' -> ')}; timeout ${r.run.timeoutMs} ms; fixture ${r.fixture.fixtureId} (${r.fixture.identitiesInFixture} identities, ${r.fixture.companies} companies)`,
  );
  lines.push(
    `Offered ${t.offered} (${r.rates.offeredPerSecond}/s, ${t.validOffered} valid); in the ${r.rates.windowSeconds} s window sent ${r.rates.sentPerSecond}/s and completed ${r.rates.completedPerSecond}/s; after it ${r.rates.sentAfterWindow} sent and ${r.rates.completedAfterWindow} completed (drain ${r.rates.drainSeconds} s); not sent ${t.notSent}`,
  );
  lines.push(
    `Outcomes: ok ${t.ok}, denied as expected ${t.deniedAsExpected}, rejected 4xx ${t.rejected4xx}, 429 ${t.throttled429}, 5xx ${t.serverErrors5xx}, timeouts ${t.timeouts}, network ${t.networkErrors}, integrity failures ${t.integrityFailures}`,
  );
  lines.push(
    `S03 failure rate ${t.s03FailureRate === null ? 'n/a' : `${(t.s03FailureRate * 100).toFixed(3)}%`} of offered valid requests (limit 0.05%); status ${JSON.stringify(r.statusCounts)}${Object.keys(r.errorCodes).length ? `; codes ${JSON.stringify(r.errorCodes)}` : ''}`,
  );
  lines.push(`Latency from scheduled time (ms): overall p50 ${f(r.latency.overall.p50)} p95 ${f(r.latency.overall.p95)} p99 ${f(r.latency.overall.p99)}; reads p95 ${f(r.latency.reads.p95)}; mutations p95 ${f(r.latency.mutations.p95)}`);
  lines.push('Per operation (offered, p50/p95/p99 ms from scheduled time):');
  for (const [op, o] of Object.entries(r.operations)) {
    const l = r.latency.byOperation[op]!;
    lines.push(`  ${op.padEnd(30)} ${String(o.offered).padStart(7)}  ${f(l.p50)}/${f(l.p95)}/${f(l.p99)}`);
  }
  lines.push(`p95 by role (ms): ${p95s(r.latency.byRole)}`);
  lines.push(`p95 by company tier (ms): ${p95s(r.latency.byTier)}; by region: ${Object.entries(r.latency.byRegion).map(([k, v]) => `${k} ${f(v.overall.p95)}`).join(', ') || 'n/a'}`);
  lines.push(`Mix (actual vs target): ${CATEGORIES.map((c) => `${c} ${(r.mix.actual[c]! * 100).toFixed(1)}%/${((r.mix.target[c] ?? 0) * 100).toFixed(1)}%`).join(', ')}`);
  lines.push(
    `Identities: ${r.identities.distinctUsed} distinct of ${r.identities.available}, max ${r.identities.maxRequestsPerIdentity} requests each, mean interval ${f(r.identities.meanRequestIntervalSeconds, ' s')}, companies ${r.identities.companiesUsed}`,
  );
  const rc = r.identities.roleCoverage;
  lines.push(
    `Roles: ${rc.roles.length} in the fixture shard; without positive requests: ${rc.withoutPositive.join(', ') || 'none'}; without negative requests: ${rc.withoutNegative.join(', ') || 'none'}`,
  );
  lines.push(
    `Negative probes: ${r.negative.planned} planned, ${r.negative.deniedAsExpected} denied as expected (${JSON.stringify(r.negative.deniedByCode)}), ${r.negative.unexpectedlyAllowed} allowed, ${r.negative.wrongStatus} wrong status`,
  );
  const g = r.generator;
  lines.push(
    `Generator: ${g.healthy ? 'healthy' : 'UNHEALTHY'}; late sends ${g.lateSends} (${(g.lateFraction * 100).toFixed(2)}%), lateness p99 ${f(g.lateness.p99)} ms, dropped ${g.droppedByGenerator}; ${g.perGenerator
      .map(
        (x) =>
          `${x.generatorId}${x.region ? ` (${x.region})` : ''}: loop delay p99 ${x.measurements.eventLoopLagMs.p99} ms, loop busy ${(x.measurements.eventLoopUtilisation * 100).toFixed(1)}%, cpu ${(x.measurements.cpu.utilisation * 100).toFixed(1)}%, rss ${x.measurements.memory.rssMaxMb} MB`,
      )
      .join('; ')}`,
  );
  for (const reason of g.reasons) lines.push(`  - ${reason}`);
  if (r.phases.length > 1) {
    lines.push('Phases (cohorts):');
    for (const p of r.phases) lines.push(`  ${p.ratePerSecond}/s x ${p.durationSeconds}s: offered ${p.offered}, p95 ${f(p.latency.overall.p95)} ms, S03 ${p.s03.pass ? 'met' : `missed (${p.s03.failed.join('; ')})`}`);
  }
  for (const w of r.fixture.reasons) lines.push(`Fixture: ${w}`);
  lines.push('');
  lines.push(r.verdict.claim);
  return lines.join('\n');
}
