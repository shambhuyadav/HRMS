// First run of a production database (admin/bootstrap.ts): one company provisioned with the baseline, its first System Administrator and
// HR Administrator (two people, BR-007), recorded as approved by the system account for this bootstrap; idempotent. Synthetic names only.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_ACTOR_ID } from '../audit/actors.js';
import { type Harness, startHarness } from '../test/harness.js';
import { bootstrapCompany } from './bootstrap.js';

describe('production bootstrap', () => {
  let h: Harness;
  const opts = { companyCode: 'synthboot', companyName: 'Synthetic Bootstrap Ltd', adminEmail: 'IT.Admin@Synth.Example', hrEmail: 'hr.lead@synth.example', effectiveFrom: '2026-11-01' };

  beforeAll(async () => {
    h = await startHarness();
  }, 300_000);

  afterAll(async () => {
    await h?.stop();
  });

  // The bootstrap runs on a connection of its own, as on the server: not the harness's (a grant bootstrap session for fixtures, which
  // would hide a grant written outside the bootstrap's own transaction).
  let own: pg.PoolClient;
  beforeAll(async () => {
    own = await h.pool.connect();
  });
  afterAll(() => own?.release());

  it('creates the company with its baseline and the two first administrators, and changes nothing on a second run', async () => {
    const first = await bootstrapCompany(own, opts);
    expect(first).toMatchObject({ companyCreated: true, granted: ['SYSTEM_ADMINISTRATOR', 'HR_ADMINISTRATOR'] });
    const roles = (
      await h.db.query<{ account_key: string; code: string; state: string; approved_by: string; effective_from: string }>(
        `select u.account_key, r.code, ra.state, ra.approved_by, to_char(ra.effective_from, 'YYYY-MM-DD') as effective_from
           from role_assignment ra join role r on r.id = ra.role_id join user_account u on u.id = ra.user_id
          where ra.company_id = $1 order by r.code`,
        [first.companyId],
      )
    ).rows;
    const idOf = async (key: string) => (await h.one<{ id: string }>(`select id from user_account where account_key = $1`, [key])).id;
    // Written by the system account, each approved by the other administrator (0146: a person, never the writer).
    expect(roles).toEqual([
      { account_key: 'hr.lead@synth.example', code: 'HR_ADMINISTRATOR', state: 'ACTIVE', approved_by: await idOf('it.admin@synth.example'), effective_from: '2026-11-01' },
      { account_key: 'it.admin@synth.example', code: 'SYSTEM_ADMINISTRATOR', state: 'ACTIVE', approved_by: await idOf('hr.lead@synth.example'), effective_from: '2026-11-01' },
    ]);
    expect((await h.one<{ n: number }>(`select count(*)::int as n from role_assignment where company_id = $1 and created_by <> $2`, [first.companyId, SYSTEM_ACTOR_ID])).n).toBe(0);
    // Each holds the role's default duties, and the company has its baseline (an inactive statutory pack, the tax declaration draft).
    expect((await h.one<{ n: number }>(`select count(*)::int as n from role_assignment_permission p join role_assignment ra on ra.id = p.role_assignment_id where ra.company_id = $1`, [first.companyId])).n).toBeGreaterThan(5);
    expect((await h.one<{ state: string }>(`select state from tax_rule_pack where company_id = $1 and code = 'INCOME_TAX_2026_27'`, [first.companyId])).state).toBe('DRAFT');
    expect((await h.one<{ code: string }>(`select code from company where id = $1`, [first.companyId])).code).toBe('SYNTHBOOT');

    const again = await bootstrapCompany(own, opts);
    expect(again).toEqual({ companyId: first.companyId, companyCreated: false, granted: [] });
    expect((await h.one<{ n: number }>(`select count(*)::int as n from role_assignment where company_id = $1`, [first.companyId])).n).toBe(2);
  });

  it('refuses one person as both administrators, and malformed input', async () => {
    await expect(bootstrapCompany(own, { ...opts, hrEmail: opts.adminEmail.toUpperCase() })).rejects.toThrow('two different people');
    await expect(bootstrapCompany(own, { ...opts, companyCode: '1BAD' })).rejects.toThrow('company code');
    await expect(bootstrapCompany(own, { ...opts, adminEmail: 'not-an-email' })).rejects.toThrow('sign-in email');
    // A refusal leaves no transaction open on the connection.
    expect((await own.query<{ idle: boolean }>(`select now() = statement_timestamp() as idle`)).rows[0]!.idle).toBe(true);
  });
});
