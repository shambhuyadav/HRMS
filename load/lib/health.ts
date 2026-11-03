// Generator health (G4/NFR-S11): a generator that cannot keep its own schedule, drops arrivals, or runs out of CPU,
// memory or event-loop time does not measure the system, so its run is BLOCKED rather than passed. Measured here
// for this process; distributed runs merge every generator's health and are blocked if any one is unhealthy.
import { cpus, freemem, totalmem } from 'node:os';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';
import type { LatencySummary } from './histogram.js';

export interface HealthThresholds {
  /** A request sent later than this after its scheduled time is a late send. */
  lateThresholdMs: number;
  /** More late sends than this share of all sends means the generator fell behind its schedule. */
  maxLateFraction: number;
  /** Event-loop delay p99 (beyond the sampling interval) above this means the generator process is saturated. */
  maxEventLoopP99Ms: number;
  /** Share of wall time the event loop was busy (event-loop utilisation, 1.0 = never idle). */
  maxEventLoopUtilisation: number;
  /** Process CPU time per wall-clock time (1.0 = one core fully busy). */
  maxCpuUtilisation: number;
  /** Peak V8 heap use as a share of the heap limit. */
  maxHeapFraction: number;
}

export const DEFAULT_HEALTH_THRESHOLDS: HealthThresholds = {
  lateThresholdMs: 50,
  maxLateFraction: 0.01,
  maxEventLoopP99Ms: 100,
  maxEventLoopUtilisation: 0.9,
  maxCpuUtilisation: 0.9,
  maxHeapFraction: 0.85,
};

/** Interval of the event-loop delay sampler; its own interval is subtracted from every sample. */
const LOOP_RESOLUTION_MS = 10;

export interface ProcessMeasurements {
  /** Delay of the event loop beyond the sampler's interval (a free loop reads near 0, plus OS timer granularity). */
  eventLoopLagMs: { p50: number; p99: number; max: number; mean: number; samples: number; resolutionMs: number };
  /** Share of wall time the event loop was busy over the run. */
  eventLoopUtilisation: number;
  cpu: { userMs: number; systemMs: number; wallMs: number; utilisation: number; cores: number };
  memory: { rssMaxMb: number; heapUsedMaxMb: number; heapLimitMb: number; heapFractionMax: number; systemTotalMb: number; systemFreeMinMb: number };
}

export interface GeneratorMeasurements extends ProcessMeasurements {
  sent: number;
  lateSends: number;
  /** Actual send (socket assigned) minus scheduled time. */
  lateness: LatencySummary;
  /** Dispatch by the scheduler loop minus scheduled time (the loop's own lag). */
  dispatchLag: LatencySummary;
  /** Arrivals not sent because the generator hit its in-flight limit. */
  droppedByGenerator: number;
  inFlightMax: number;
  maxInFlight: number;
  preflight: { ok: boolean; detail: string } | null;
}

const mb = (bytes: number) => Math.round((bytes / 1_048_576) * 10) / 10;
const ms3 = (v: number) => Math.round(v * 1000) / 1000;

/** Samples event-loop delay, CPU and memory of this process until stopped. */
export function startHealthMonitor(sampleEveryMs = 1000): { stop(): ProcessMeasurements } {
  // The histogram records the whole time between two sampler ticks, so an idle loop reads about the resolution;
  // the resolution is subtracted to report the delay the loop itself added.
  const loop = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
  loop.enable();
  const elu0 = performance.eventLoopUtilization();
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  const heapLimit = getHeapStatistics().heap_size_limit;
  let rssMax = 0;
  let heapMax = 0;
  let freeMin = freemem();
  const sample = () => {
    const m = process.memoryUsage();
    rssMax = Math.max(rssMax, m.rss);
    heapMax = Math.max(heapMax, m.heapUsed);
    freeMin = Math.min(freeMin, freemem());
  };
  sample();
  const timer = setInterval(sample, sampleEveryMs);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      sample();
      loop.disable();
      const elu = performance.eventLoopUtilization(elu0);
      const cpu = process.cpuUsage(cpu0);
      const wallMs = performance.now() - t0;
      const samples = loop.count;
      const lag = (v: number) => (samples > 0 ? ms3(Math.max(0, v / 1e6 - LOOP_RESOLUTION_MS)) : 0);
      return {
        eventLoopLagMs: { p50: lag(loop.percentile(50)), p99: lag(loop.percentile(99)), max: lag(loop.max), mean: lag(loop.mean), samples, resolutionMs: LOOP_RESOLUTION_MS },
        eventLoopUtilisation: Math.round(elu.utilization * 1000) / 1000,
        cpu: {
          userMs: Math.round(cpu.user / 1000),
          systemMs: Math.round(cpu.system / 1000),
          wallMs: Math.round(wallMs),
          utilisation: wallMs > 0 ? Math.round(((cpu.user + cpu.system) / 1000 / wallMs) * 1000) / 1000 : 0,
          cores: cpus().length,
        },
        memory: {
          rssMaxMb: mb(rssMax),
          heapUsedMaxMb: mb(heapMax),
          heapLimitMb: mb(heapLimit),
          heapFractionMax: Math.round((heapMax / heapLimit) * 1000) / 1000,
          systemTotalMb: mb(totalmem()),
          systemFreeMinMb: mb(freeMin),
        },
      };
    },
  };
}

const pct = (v: number) => `${(v * 100).toFixed(2)}%`;

/** The rules that decide whether a generator kept its schedule and its own resources (pure, so it can be tested). */
export function assessGeneratorHealth(m: GeneratorMeasurements, t: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS): { healthy: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (m.preflight && !m.preflight.ok) reasons.push(`preflight failed: ${m.preflight.detail}`);
  const lateFraction = m.sent > 0 ? m.lateSends / m.sent : 0;
  if (lateFraction > t.maxLateFraction) {
    reasons.push(`fell behind its schedule: ${pct(lateFraction)} of sends were more than ${t.lateThresholdMs} ms late (limit ${pct(t.maxLateFraction)}; p99 lateness ${m.lateness.p99 ?? 0} ms)`);
  }
  if (m.droppedByGenerator > 0) reasons.push(`${m.droppedByGenerator} arrivals dropped at the generator's in-flight limit (${m.maxInFlight})`);
  if (m.eventLoopLagMs.p99 > t.maxEventLoopP99Ms) reasons.push(`event-loop delay p99 ${m.eventLoopLagMs.p99} ms exceeds ${t.maxEventLoopP99Ms} ms`);
  if (m.eventLoopUtilisation > t.maxEventLoopUtilisation) {
    reasons.push(`event loop busy ${pct(m.eventLoopUtilisation)} of the run exceeds ${pct(t.maxEventLoopUtilisation)}`);
  }
  if (m.cpu.utilisation > t.maxCpuUtilisation) reasons.push(`process CPU ${pct(m.cpu.utilisation)} of one core exceeds ${pct(t.maxCpuUtilisation)}`);
  if (m.memory.heapFractionMax > t.maxHeapFraction) reasons.push(`heap use ${pct(m.memory.heapFractionMax)} of its limit exceeds ${pct(t.maxHeapFraction)}`);
  return { healthy: reasons.length === 0, reasons };
}
