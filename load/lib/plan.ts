// BRD v8.2 Appendix G2 fixture shape: company skew and role distribution, as pure arithmetic so the plan
// can be checked without a database. The plan only sizes a fixture; it proves nothing about capacity (G5).
import { BASELINE_ROLES } from '../../apps/api/src/modules/access/baseline.js';

export type CompanyTier = 'HOT' | 'LARGE' | 'TAIL';

/** G2 "initial representative fixture" values. */
export const G2 = {
  /** One company carries 10% of active users/traffic. */
  hotShare: 0.1,
  /** Nine companies carry 2% each. */
  largeShare: 0.02,
  largeCount: 9,
  /** The remaining companies share 72%. */
  tailShare: 0.72,
  /** 90% Employee, 5% Reporting Manager, 2% HR Administrator, 1% System Administrator ... */
  roleShares: { EMPLOYEE: 0.9, REPORTING_MANAGER: 0.05, HR_ADMINISTRATOR: 0.02, SYSTEM_ADMINISTRATOR: 0.01 } as Readonly<Record<string, number>>,
  /** ... and 2% split across the remaining baseline roles. */
  otherRolesShare: 0.02,
} as const;

/** Every company needs a Reporting Manager (top of the hierarchy) and an HR Administrator (fallback reviewer, policy activator). */
export const MIN_COMPANY_SIZE = 2;

export const ROLE_CODES: readonly string[] = BASELINE_ROLES.map((r) => r.code);

/**
 * Company shares. With at least 46 companies these are exactly G2 (10% / 9 x 2% / the rest share 72%). With fewer
 * companies the tail cannot absorb 72% without its companies outgrowing the large ones, so the hot and large shares
 * are scaled up by one common factor: the order hot > large >= tail is kept and the shares still sum to 1
 * (2 companies: 83.3% / 16.7%; 11 companies: 33.3% / 9 x 6.7% / 6.7%).
 */
export function companyShares(companies: number): { tier: CompanyTier; share: number }[] {
  if (!Number.isInteger(companies) || companies < 1) throw new Error('companies must be a positive integer');
  const large = Math.min(G2.largeCount, companies - 1);
  const tail = companies - 1 - large;
  const factor = tail === 0 ? 1 / (G2.hotShare + G2.largeShare * large) : Math.max(1, 1 / (G2.hotShare + G2.largeShare * (large + tail)));
  const hot = G2.hotShare * factor;
  const largeEach = G2.largeShare * factor;
  const tailEach = tail === 0 ? 0 : (1 - hot - largeEach * large) / tail;
  const shares: { tier: CompanyTier; share: number }[] = [{ tier: 'HOT', share: hot }];
  for (let i = 0; i < large; i++) shares.push({ tier: 'LARGE', share: largeEach });
  for (let i = 0; i < tail; i++) shares.push({ tier: 'TAIL', share: tailEach });
  return shares;
}

/** Largest-remainder apportionment: integer counts proportional to `weights` that sum exactly to `total`. */
export function apportion(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) throw new Error('weights must have a positive sum');
  const exact = weights.map((w) => (w / sum) * total);
  const counts = exact.map((e) => Math.floor(e));
  let rest = total - counts.reduce((a, b) => a + b, 0);
  const order = exact.map((e, i) => ({ r: e - Math.floor(e), i })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; k < order.length && rest > 0; k++, rest--) counts[order[k]!.i]! += 1;
  return counts;
}

/** Target share of each baseline role (G2), with the "remaining roles" share split evenly. */
export function roleTargetShares(): Record<string, number> {
  const others = ROLE_CODES.filter((c) => G2.roleShares[c] === undefined);
  return Object.fromEntries(ROLE_CODES.map((c) => [c, G2.roleShares[c] ?? G2.otherRolesShare / others.length]));
}

const ROLE_MINIMUM: Readonly<Record<string, number>> = { REPORTING_MANAGER: 1, HR_ADMINISTRATOR: 1 };

/**
 * Role counts for one company of `size` identities: G2 shares, then the per-company minimums. `carry` holds how far
 * earlier companies were over (+) or under (-) their role targets; it is updated, so rounding error diffuses across
 * companies instead of accumulating (a 72-person tail company cannot hold 0.2% roles, but every few of them can).
 */
export function roleCounts(size: number, carry?: Record<string, number>): Record<string, number> {
  if (size < MIN_COMPANY_SIZE) throw new Error(`A company needs at least ${MIN_COMPANY_SIZE} identities`);
  const targets = roleTargetShares();
  const counts: Record<string, number> = {};
  const ideal = ROLE_CODES.map((c) => Math.max(0, targets[c]! * size - (carry?.[c] ?? 0)));
  apportion(size, ideal.some((v) => v > 0) ? ideal : ROLE_CODES.map((c) => targets[c]!)).forEach((n, i) => (counts[ROLE_CODES[i]!] = n));
  for (const [code, min] of Object.entries(ROLE_MINIMUM)) {
    while ((counts[code] ?? 0) < min) {
      const donor = ROLE_CODES.filter((c) => (counts[c] ?? 0) > (ROLE_MINIMUM[c] ?? 0)).sort((a, b) => counts[b]! - counts[a]!)[0];
      if (!donor) throw new Error('Company too small for its minimum roles');
      counts[donor]! -= 1;
      counts[code] = (counts[code] ?? 0) + 1;
    }
  }
  if (carry) for (const c of ROLE_CODES) carry[c] = (carry[c] ?? 0) + (counts[c] ?? 0) - targets[c]! * size;
  return counts;
}

export interface CompanyPlan {
  index: number;
  tier: CompanyTier;
  /** G2 (or scaled) share this company was sized from. */
  targetShare: number;
  identities: number;
  roles: Record<string, number>;
}

export interface FixturePlan {
  companies: CompanyPlan[];
  identities: number;
  roleTotals: Record<string, number>;
  roleTargetShares: Record<string, number>;
  warnings: string[];
}

/**
 * Sizes every company and its roles. `coverAllRoles` converts Employees of the largest companies into any baseline
 * role that rounding left empty, so all 14 roles issue requests even in a tiny fixture; the deviation from G2 is
 * reported, never hidden (G2: actual counts are documented).
 */
export function planFixture(identities: number, companies: number, opts: { coverAllRoles?: boolean } = {}): FixturePlan {
  if (!Number.isInteger(identities) || identities < 1) throw new Error('identities must be a positive integer');
  if (identities < companies * MIN_COMPANY_SIZE) {
    throw new Error(`${companies} companies need at least ${companies * MIN_COMPANY_SIZE} identities (${MIN_COMPANY_SIZE} per company)`);
  }
  const shares = companyShares(companies);
  const sizes = apportion(identities, shares.map((s) => s.share));
  // Minimum size: lift small companies to the minimum and take the difference from the largest ones.
  let deficit = 0;
  for (let i = 0; i < sizes.length; i++) {
    if (sizes[i]! < MIN_COMPANY_SIZE) {
      deficit += MIN_COMPANY_SIZE - sizes[i]!;
      sizes[i] = MIN_COMPANY_SIZE;
    }
  }
  for (const i of sizes.map((n, idx) => ({ n, idx })).sort((a, b) => b.n - a.n).map((s) => s.idx)) {
    if (deficit === 0) break;
    const take = Math.min(deficit, sizes[i]! - MIN_COMPANY_SIZE);
    sizes[i]! -= take;
    deficit -= take;
  }
  const carry: Record<string, number> = {};
  const plans: CompanyPlan[] = shares.map((s, index) => ({ index, tier: s.tier, targetShare: s.share, identities: sizes[index]!, roles: roleCounts(sizes[index]!, carry) }));
  const warnings: string[] = [];
  if (opts.coverAllRoles ?? true) {
    for (const code of ROLE_CODES) {
      if (plans.some((p) => (p.roles[code] ?? 0) > 0)) continue;
      const donor = [...plans].sort((a, b) => (b.roles.EMPLOYEE ?? 0) - (a.roles.EMPLOYEE ?? 0))[0];
      if (!donor || (donor.roles.EMPLOYEE ?? 0) < 2) {
        warnings.push(`No Employee left to convert into ${code}; that role has no identity in this fixture`);
        continue;
      }
      donor.roles.EMPLOYEE! -= 1;
      donor.roles[code] = (donor.roles[code] ?? 0) + 1;
    }
  }
  const roleTotals: Record<string, number> = Object.fromEntries(ROLE_CODES.map((c) => [c, plans.reduce((n, p) => n + (p.roles[c] ?? 0), 0)]));
  const targets = roleTargetShares();
  for (const code of ROLE_CODES) {
    const actual = roleTotals[code]! / identities;
    if (Math.abs(actual - targets[code]!) > 0.01) {
      warnings.push(`${code}: ${(actual * 100).toFixed(1)}% of identities (G2 target ${(targets[code]! * 100).toFixed(1)}%) at this fixture size`);
    }
  }
  return { companies: plans, identities, roleTotals, roleTargetShares: targets, warnings };
}
