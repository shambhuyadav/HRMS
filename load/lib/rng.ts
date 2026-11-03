// Seeded pseudo-random numbers so a fixture plan and an arrival schedule can be reproduced from a seed.
// Not cryptographic: identifiers and secrets never come from here (they use node:crypto).

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
  /** Exponential variate with the given mean (Poisson inter-arrival gaps). */
  exponential(mean: number): number;
}

/** mulberry32: small, fast, good enough for load shaping. */
export function createRng(seed: number): Rng {
  let state = (seed >>> 0) ^ 0x9e3779b9;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (maxExclusive) => Math.floor(next() * maxExclusive),
    // 1 - next() is in (0, 1], so the logarithm is finite.
    exponential: (mean) => -Math.log(1 - next()) * mean,
  };
}

/** Fisher-Yates shuffle in place. */
export function shuffleInPlace<T>(items: T[], rng: Rng): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const a = items[i] as T;
    items[i] = items[j] as T;
    items[j] = a;
  }
  return items;
}

/** Derives an independent seed for a sub-stream (e.g. one generator shard). */
export function deriveSeed(seed: number, salt: number): number {
  let h = (seed ^ Math.imul(salt + 1, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}
