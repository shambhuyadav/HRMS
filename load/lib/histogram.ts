// Log-bucketed latency histogram: bounded memory at any request count, mergeable across distributed generators
// (bucket counts add), percentiles within 1% relative error. Exact count/min/max/sum are kept alongside.

/** Bucket i covers (MIN_MS * GROWTH^i, MIN_MS * GROWTH^(i+1)]; values at or below MIN_MS fall into bucket 0. */
const MIN_MS = 0.01;
const GROWTH = 1.01;
const LOG_GROWTH = Math.log(GROWTH);

export interface SerializedHistogram {
  /** [bucketIndex, count] pairs, ascending. */
  buckets: [number, number][];
  count: number;
  sumMs: number;
  minMs: number | null;
  maxMs: number | null;
}

export interface LatencySummary {
  count: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
  mean: number | null;
}

const round = (v: number) => Math.round(v * 1000) / 1000;

export class LogHistogram {
  private readonly counts = new Map<number, number>();
  count = 0;
  sumMs = 0;
  minMs = Number.POSITIVE_INFINITY;
  maxMs = 0;

  static bucketOf(ms: number): number {
    return ms <= MIN_MS ? 0 : Math.max(0, Math.ceil(Math.log(ms / MIN_MS) / LOG_GROWTH) - 1);
  }

  static upperBound(bucket: number): number {
    return MIN_MS * GROWTH ** (bucket + 1);
  }

  record(ms: number): void {
    const v = Number.isFinite(ms) && ms > 0 ? ms : 0;
    const b = LogHistogram.bucketOf(v);
    this.counts.set(b, (this.counts.get(b) ?? 0) + 1);
    this.count++;
    this.sumMs += v;
    if (v < this.minMs) this.minMs = v;
    if (v > this.maxMs) this.maxMs = v;
  }

  merge(other: LogHistogram | SerializedHistogram): this {
    const s = other instanceof LogHistogram ? other.toJSON() : other;
    for (const [b, n] of s.buckets) this.counts.set(b, (this.counts.get(b) ?? 0) + n);
    this.count += s.count;
    this.sumMs += s.sumMs;
    if (s.minMs !== null && s.minMs < this.minMs) this.minMs = s.minMs;
    if (s.maxMs !== null && s.maxMs > this.maxMs) this.maxMs = s.maxMs;
    return this;
  }

  /** The smallest bucket upper bound covering quantile q (never above the observed maximum). */
  percentile(q: number): number | null {
    if (this.count === 0) return null;
    const rank = Math.max(1, Math.ceil(q * this.count));
    let seen = 0;
    for (const b of [...this.counts.keys()].sort((x, y) => x - y)) {
      seen += this.counts.get(b)!;
      if (seen >= rank) return round(Math.min(LogHistogram.upperBound(b), this.maxMs));
    }
    return round(this.maxMs);
  }

  summary(): LatencySummary {
    return {
      count: this.count,
      p50: this.percentile(0.5),
      p95: this.percentile(0.95),
      p99: this.percentile(0.99),
      max: this.count ? round(this.maxMs) : null,
      mean: this.count ? round(this.sumMs / this.count) : null,
    };
  }

  toJSON(): SerializedHistogram {
    return {
      buckets: [...this.counts.entries()].sort((a, b) => a[0] - b[0]),
      count: this.count,
      sumMs: round(this.sumMs),
      minMs: this.count ? round(this.minMs) : null,
      maxMs: this.count ? round(this.maxMs) : null,
    };
  }

  static from(s: SerializedHistogram): LogHistogram {
    return new LogHistogram().merge(s);
  }
}
