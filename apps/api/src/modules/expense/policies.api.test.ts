// Expense policy maintenance over HTTP (FR-078; BR-019; DF06; DB047-DB049; C4; 0116): dated draft revisions with category
// rules, independent activation that closes the revision it replaces, overlaps and ties refused, retirement, frozen rules, and
// submission judged by the revision and classification of the expense date. Synthetic data only: limits here are test values.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHECK_VIOLATION, expectSqlError, uniq } from '../../../../../db/tests/fixtures.js';
import { withTransaction } from '../../db/transaction.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { type AccessGrant, resolveAccess } from '../access/authorize.js';
import type { PermissionKey } from '../access/baseline.js';
import { activateExpensePolicy, createExpensePolicy, retireExpensePolicy } from './policies.js';

let h: Harness;

const POLICIES = '/v1/expense/policies';
const FINANCE: PermissionKey[] = ['expense.read.operational', 'expense.manager_decide.operational', 'expense.finance_decide.operational', 'expense.high_value_decide.operational'];

const daysAgo = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
const values = (overrides: Record<string, unknown> = {}) => ({ effectiveFrom: daysAgo(5), submissionWindowDays: 30, highValueThreshold: '50000', ...overrides });
const newCode = () => `P_${uniq('c').replace(/[^A-Za-z0-9]/g, '').toUpperCase()}`.slice(0, 40);

type Rule = { id: string; category: string; gradeId: string | null; locationId: string | null; limitAmount: string; receiptRequired: boolean; priority: number };
type Policy = {
  id: string;
  code: string;
  revision: number;
  version: number;
  state: string;
  currency: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  submissionWindowDays: number;
  highValueThreshold: string;
  rules: Rule[];
  warnings: { code: string; text: string }[];
  lastUsedOn: string | null;
};

/** One company of its own: expense policies apply to a whole company by date, so tests do not share a timeline. */
interface World {
  c: Company;
  author: TestActor;
  activator: TestActor;
  fin: TestActor;
  manager: TestActor;
  employee: TestActor;
  employeeId: string;
  categories: Record<string, string>;
  /** The provisioned DEFAULT revision 1, activated. */
  seeded: Policy;
}

const list = async (w: World) => (await h.call(w.author, 'GET', POLICIES)).json().items as Policy[];
const policy = async (w: World, id: string) => (await list(w)).find((p) => p.id === id)!;
const activate = (a: TestActor, id: string, expectedVersion: number) => h.call(a, 'POST', `${POLICIES}/${id}/activate`, { expectedVersion });
const retire = (a: TestActor, id: string, expectedVersion: number, effectiveTo: string, reason = 'Synthetic: replaced') => h.call(a, 'POST', `${POLICIES}/${id}/retire`, { expectedVersion, effectiveTo, reason });

async function world(): Promise<World> {
  const c = await h.makeCompany();
  const author = await h.actor(c, 'HR_ADMINISTRATOR');
  const activator = await h.actor(c, 'HR_ADMINISTRATOR');
  const fin = await h.actor(c, 'HR_ADMINISTRATOR', { extra: FINANCE });
  const fin2 = await h.actor(c, 'HR_ADMINISTRATOR', { extra: FINANCE });
  await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'expense_claim', $2, 1, true), ($1, 'expense_claim', $3, 2, true)`, [c.id, fin.user, fin2.user]);
  const person = async () => {
    const e = (await h.call(author, 'POST', '/v1/employees', h.newEmployeeBody(c))).json();
    await h.setStatus(c, e.id, 'ACTIVE_CONFIRMED');
    return e.id as string;
  };
  const managerEmp = await person();
  const employeeId = await person();
  await h.call(author, 'POST', `/v1/employees/${employeeId}/manager`, { managerEmployeeId: managerEmp, effectiveFrom: '2026-01-05' });
  const manager = await h.actor(c, 'REPORTING_MANAGER', { employeeId: managerEmp });
  const employee = await h.actor(c, 'EMPLOYEE', { employeeId });
  const options = (await h.call(author, 'GET', '/v1/expense/policy-options')).json();
  const categories = Object.fromEntries((options.categories as { code: string; id: string }[]).map((x) => [x.code, x.id]));
  const seeded = ((await h.call(author, 'GET', POLICIES)).json().items as Policy[]).find((p) => p.code === 'DEFAULT')!;
  expect(seeded).toMatchObject({ state: 'DRAFT', currency: 'INR', submissionWindowDays: 30, highValueThreshold: '50000.0000' });
  expect((await activate(activator, seeded.id, seeded.version)).json()).toMatchObject({ id: seeded.id, state: 'ACTIVE', closed: [] });
  return { c, author, activator, fin, manager, employee, employeeId, categories, seeded: { ...seeded, state: 'ACTIVE', version: seeded.version + 1 } };
}

/** A draft of `code` with these rules (category code, limit, and optionally what it names). */
async function draft(w: World, code: string, overrides: Record<string, unknown>, rules: { category: string; limit: string; gradeId?: string; locationId?: string; receiptRequired?: boolean }[]) {
  const created = await h.call(w.author, 'POST', POLICIES, { code, ...values(overrides) });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json().id as string;
  let version = created.json().version as number;
  for (const r of rules) {
    const added = await h.call(w.author, 'POST', `${POLICIES}/${id}/rules`, {
      expectedVersion: version,
      categoryId: w.categories[r.category],
      limitAmount: r.limit,
      receiptRequired: r.receiptRequired ?? true,
      ...(r.gradeId ? { gradeId: r.gradeId } : {}),
      ...(r.locationId ? { locationId: r.locationId } : {}),
    });
    expect(added.statusCode, added.body).toBe(201);
    version = added.json().policyVersion;
  }
  return policy(w, id);
}
async function activated(w: World, code: string, overrides: Record<string, unknown>, rules: Parameters<typeof draft>[3]) {
  const p = await draft(w, code, overrides, rules);
  const res = await activate(w.activator, p.id, p.version);
  expect(res.statusCode, res.body).toBe(200);
  return policy(w, p.id);
}

const master = async (w: World, table: 'grade' | 'location') => {
  const code = uniq('M').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return (await h.one<{ id: string }>(`insert into ${table} (company_id, code, name, active) values ($1, $2, $2, true) returning id`, [w.c.id, code])).id;
};
const placed = (w: World, gradeId: string | null, locationId: string | null) => h.db.query(`update employment_assignment set grade_id = $2, location_id = coalesce($3, location_id) where employee_id = $1`, [w.employeeId, gradeId, locationId]);

const receipt = async (a: TestActor) => {
  const res = await h.call(a, 'POST', '/v1/expense/receipts', { fileName: 'r.pdf', contentBase64: Buffer.from(`%PDF-1.4\n% synthetic policy receipt ${uniq('p')}\n%%EOF\n`).toString('base64') });
  expect(res.statusCode).toBe(201);
  return { receiptId: res.json().receiptId as string };
};
const line = async (w: World, category: string, amount: string, expenseDate: string, extra: Record<string, unknown> = {}) => ({
  category,
  expenseDate,
  merchant: `Synthetic Merchant ${uniq('m')}`,
  grossAmount: amount,
  claimedAmount: amount,
  description: `${category} (synthetic)`,
  receipt: await receipt(w.employee),
  ...extra,
});
const claimOf = async (w: World, id: string, a: TestActor = w.employee) => (await h.call(a, 'GET', `/v1/expense/claims/${id}`)).json();
const newClaim = async (w: World, lines: object[]) => {
  const res = await h.call(w.employee, 'POST', '/v1/expense/claims', { purpose: 'Policy check (synthetic)', currency: 'INR', lines });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().claimId as string;
};
const submit = async (w: World, id: string) => h.call(w.employee, 'POST', `/v1/expense/claims/${id}/submit`, { expectedVersion: (await claimOf(w, id)).version });
const submitted = async (w: World, lines: object[]) => {
  const id = await newClaim(w, lines);
  const res = await submit(w, id);
  expect(res.statusCode, res.body).toBe(200);
  return id;
};
const pinnedPolicy = async (claimId: string) =>
  (await h.one<{ policy_id: string }>(`select r.policy_id from expense_claim c join expense_revision r on r.company_id = c.company_id and r.claim_id = c.id and r.revision = c.current_revision where c.id = $1`, [claimId])).policy_id;

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h?.stop();
});

describe('draft revisions (FR-078, DF06)', () => {
  let w: World;
  beforeAll(async () => {
    w = await world();
  });

  it('takes every value from the person maintaining it, numbers revisions per code, and is INR only in wave 1', async () => {
    const code = newCode();
    const created = await h.call(w.author, 'POST', POLICIES, { code, ...values({ effectiveTo: '2035-01-01', submissionWindowDays: 15, highValueThreshold: '1234.50' }) });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({ code, revision: 1, state: 'DRAFT' });
    const shown = await policy(w, created.json().id);
    expect(shown).toMatchObject({ currency: 'INR', effectiveTo: '2035-01-01', submissionWindowDays: 15, highValueThreshold: '1234.5000', rules: [], lastUsedOn: null });
    // A new code beside the open DEFAULT revision: nobody could claim under it, and it could not be activated as it stands.
    expect(shown.warnings.map((x) => x.code)).toEqual(['NO_RULES', 'OVERLAPPING']);
    expect((await h.call(w.author, 'POST', POLICIES, { code, ...values() })).json().revision).toBe(2);

    // Nothing defaults to DF06's values, and foreign currency stays disabled.
    const { submissionWindowDays: _s, ...noWindow } = values();
    expect((await h.call(w.author, 'POST', POLICIES, { code: newCode(), ...noWindow })).statusCode).toBe(400);
    const { highValueThreshold: _t, ...noThreshold } = values();
    expect((await h.call(w.author, 'POST', POLICIES, { code: newCode(), ...noThreshold })).statusCode).toBe(400);
    expect((await h.call(w.author, 'POST', POLICIES, { code: newCode(), ...values({ currency: 'USD' }) })).statusCode).toBe(400);
  });

  it('refuses values that cannot work', async () => {
    const post = (overrides: Record<string, unknown>) => h.call(w.author, 'POST', POLICIES, { code: newCode(), ...values(overrides) });
    expect((await post({ effectiveFrom: '2030-01-01', effectiveTo: '2030-01-01' })).json().error).toBe('INVALID_PERIOD');
    expect((await post({ highValueThreshold: '0' })).statusCode).toBe(400);
    expect((await post({ highValueThreshold: '10.123' })).statusCode).toBe(400);
    expect((await post({ submissionWindowDays: 0 })).statusCode).toBe(400);
    expect((await h.call(w.author, 'POST', POLICIES, { code: 'lower-case', ...values() })).statusCode).toBe(400);
  });

  it('edits a draft under its version and maintains its rules; a limit is always stated', async () => {
    const p = await draft(w, newCode(), { effectiveFrom: '2030-02-01' }, []);
    const edited = await h.call(w.author, 'PATCH', `${POLICIES}/${p.id}`, { expectedVersion: p.version, submissionWindowDays: 20 });
    expect(edited.json()).toEqual({ id: p.id, version: p.version + 1 });
    expect((await h.call(w.author, 'PATCH', `${POLICIES}/${p.id}`, { expectedVersion: p.version, submissionWindowDays: 21 })).json().error).toBe('STALE_VERSION');
    expect((await h.call(w.author, 'PATCH', `${POLICIES}/${p.id}`, { expectedVersion: p.version + 1 })).statusCode).toBe(400);
    expect((await h.call(w.author, 'PATCH', `${POLICIES}/${p.id}`, { expectedVersion: p.version + 1, effectiveTo: '2030-01-01' })).json().error).toBe('INVALID_PERIOD');
    expect((await policy(w, p.id)).submissionWindowDays).toBe(20);

    let version = p.version + 1;
    const gradeId = await master(w, 'grade');
    const rule = { categoryId: w.categories.MEALS, gradeId, limitAmount: '1500.50', receiptRequired: false };
    const added = await h.call(w.author, 'POST', `${POLICIES}/${p.id}/rules`, { expectedVersion: version, ...rule });
    expect(added.statusCode, added.body).toBe(201);
    version = added.json().policyVersion;
    expect((await policy(w, p.id)).rules).toEqual([expect.objectContaining({ id: added.json().id, category: 'MEALS', gradeId, locationId: null, limitAmount: '1500.5000', receiptRequired: false, priority: 1 })]);
    expect((await h.call(w.author, 'POST', `${POLICIES}/${p.id}/rules`, { expectedVersion: version, ...rule })).json().error).toBe('RULE_EXISTS');
    expect((await h.call(w.author, 'POST', `${POLICIES}/${p.id}/rules`, { expectedVersion: version, ...rule, gradeId: '00000000-0000-4000-8000-000000000000' })).json().error).toBe('INVALID_REFERENCE');
    const { limitAmount: _l, ...noLimit } = rule;
    expect((await h.call(w.author, 'POST', `${POLICIES}/${p.id}/rules`, { expectedVersion: version, ...noLimit, categoryId: w.categories.OTHER })).statusCode).toBe(400);
    expect((await h.call(w.author, 'POST', `${POLICIES}/${p.id}/rules`, { expectedVersion: version, ...rule, categoryId: w.categories.OTHER, limitAmount: '0' })).statusCode).toBe(400);
    expect((await h.call(w.author, 'POST', `${POLICIES}/${p.id}/rules`, { expectedVersion: p.version, ...rule, categoryId: w.categories.OTHER })).json().error).toBe('STALE_VERSION');

    const removed = await h.call(w.author, 'POST', `${POLICIES}/${p.id}/rules/${added.json().id}/remove`, { expectedVersion: version });
    expect(removed.json()).toEqual({ policyVersion: version + 1 });
    expect((await policy(w, p.id)).rules).toEqual([]);
    expect((await h.call(w.author, 'POST', `${POLICIES}/${p.id}/rules/${added.json().id}/remove`, { expectedVersion: version + 1 })).statusCode).toBe(404);
  });

  it('every change of a draft is audited', async () => {
    const p = await draft(w, newCode(), { effectiveFrom: '2030-03-01' }, [{ category: 'OTHER', limit: '100' }]);
    await h.call(w.author, 'PATCH', `${POLICIES}/${p.id}`, { expectedVersion: p.version, submissionWindowDays: 25 });
    await h.call(w.author, 'POST', `${POLICIES}/${p.id}/rules/${p.rules[0]!.id}/remove`, { expectedVersion: p.version + 1 });
    const actions = (await h.db.query<{ action: string }>(`select action from audit_event where resource_code = 'expense_policy' and record_key = $1 order by occurred_at`, [p.id])).rows.map((r) => r.action);
    expect(actions).toEqual(['CREATE', 'ADD_RULE', 'UPDATE', 'REMOVE_RULE']);
  });

  it('only an unrestricted company-scope holder of the duty maintains; another company reads as missing', async () => {
    const p = await draft(w, newCode(), { effectiveFrom: '2030-04-01' }, [{ category: 'OTHER', limit: '100' }]);
    const narrowed = await h.actor(w.c, 'HR_ADMINISTRATOR', { departmentFilter: w.c.dept });
    expect((await h.call(narrowed, 'POST', POLICIES, { code: newCode(), ...values() })).statusCode).toBe(403);
    expect((await h.call(narrowed, 'POST', `${POLICIES}/${p.id}/rules`, { expectedVersion: p.version, categoryId: w.categories.MEALS, limitAmount: '5', receiptRequired: true })).statusCode).toBe(403);
    expect((await activate(narrowed, p.id, p.version)).statusCode).toBe(403);
    expect((await h.call(w.employee, 'GET', POLICIES)).statusCode).toBe(403);
    expect((await h.call(w.employee, 'POST', POLICIES, { code: newCode(), ...values() })).statusCode).toBe(403);
    expect((await h.call(w.manager, 'POST', `${POLICIES}/${p.id}/activate`, { expectedVersion: p.version })).statusCode).toBe(403);

    const other = await world();
    expect((await activate(other.activator, p.id, p.version)).statusCode).toBe(404);
    expect((await h.call(other.author, 'PATCH', `${POLICIES}/${p.id}`, { expectedVersion: p.version, submissionWindowDays: 9 })).statusCode).toBe(404);
    const foreign = await draft(other, newCode(), { effectiveFrom: '2030-05-01' }, []);
    const foreignRule = await h.call(other.author, 'POST', `${POLICIES}/${foreign.id}/rules`, { expectedVersion: foreign.version, categoryId: w.categories.MEALS, limitAmount: '5', receiptRequired: true });
    expect(foreignRule.json().error).toBe('INVALID_REFERENCE');
  });

  it('create, activate and retire re-check the duty inside their transaction', async () => {
    const p = await draft(w, newCode(), { effectiveFrom: '2031-01-01' }, [{ category: 'OTHER', limit: '100' }]);
    const later = await h.actor(w.c, 'HR_ADMINISTRATOR');
    const grantFor = async (action: string) => (await resolveAccess(h.pool, { userId: later.user, companyId: w.c.id, assignmentId: later.assignment, resource: 'expense_policy', action, fieldGroups: ['operational'] })) as AccessGrant;
    const activating = await grantFor('activate');
    const managing = await grantFor('manage');
    expect(activating.allowed && managing.allowed).toBe(true);
    await h.db.query(`update role_assignment_permission set active = false where company_id = $1 and role_assignment_id = $2 and permission_id in (select id from permission where resource = 'expense_policy')`, [w.c.id, later.assignment]);
    await expect(withTransaction(h.pool, (tx) => activateExpensePolicy(tx, activating, p.id, p.version))).rejects.toMatchObject({ statusCode: 403 });
    expect((await policy(w, p.id)).state).toBe('DRAFT');
    await expect(withTransaction(h.pool, (tx) => createExpensePolicy(tx, managing, { code: newCode(), ...values() }))).rejects.toMatchObject({ statusCode: 403 });
    await expect(withTransaction(h.pool, (tx) => retireExpensePolicy(tx, activating, w.seeded.id, { expectedVersion: w.seeded.version, effectiveTo: '2040-01-01', reason: 'x' }))).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('activation (C4; DB049)', () => {
  it('neither its author nor its last editor activates it; someone else does, once', async () => {
    const w = await world();
    const editor = await h.actor(w.c, 'HR_ADMINISTRATOR');
    const p = await draft(w, 'DEFAULT', { effectiveFrom: '2030-01-01' }, [{ category: 'OTHER', limit: '100' }]);
    expect((await activate(w.author, p.id, p.version)).json().error).toBe('SELF_APPROVAL');
    const edited = await h.call(editor, 'PATCH', `${POLICIES}/${p.id}`, { expectedVersion: p.version, submissionWindowDays: 12 });
    expect(edited.statusCode).toBe(200);
    expect((await activate(editor, p.id, edited.json().version)).json().error).toBe('SELF_APPROVAL');
    expect((await activate(w.activator, p.id, p.version)).json().error).toBe('STALE_VERSION');
    const done = await activate(w.activator, p.id, edited.json().version);
    expect(done.json()).toMatchObject({ id: p.id, state: 'ACTIVE' });
    expect((await activate(w.activator, p.id, edited.json().version + 1)).json().error).toBe('INVALID_STATE');
    // A revision that is no longer a draft changes only by a new revision.
    expect((await h.call(w.author, 'PATCH', `${POLICIES}/${p.id}`, { expectedVersion: (await policy(w, p.id)).version, submissionWindowDays: 13 })).json().error).toBe('POLICY_NOT_DRAFT');
    expect((await h.call(w.author, 'POST', `${POLICIES}/${p.id}/rules`, { expectedVersion: (await policy(w, p.id)).version, categoryId: w.categories.MEALS, limitAmount: '5', receiptRequired: true })).json().error).toBe('POLICY_NOT_DRAFT');
  });

  it('a revision with no rules, or with rules that tie, is refused; a rule naming both settles the tie', async () => {
    const w = await world();
    const empty = await draft(w, newCode(), { effectiveFrom: '2030-01-01' }, []);
    expect((await activate(w.activator, empty.id, empty.version)).json().error).toBe('POLICY_HAS_NO_RULES');

    const [gradeId, locationId] = [await master(w, 'grade'), await master(w, 'location')];
    const tied = await draft(w, newCode(), { effectiveFrom: '2030-01-01' }, [
      { category: 'MEALS', limit: '700', gradeId },
      { category: 'MEALS', limit: '800', locationId },
    ]);
    expect(tied.warnings.map((x) => x.code)).toContain('TIED_RULES');
    const refused = await activate(w.activator, tied.id, tied.version);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'POLICY_AMBIGUOUS', details: { ties: [{ category: 'MEALS' }] } });
    expect((await policy(w, tied.id)).state).toBe('DRAFT');

    const settled = await h.call(w.author, 'POST', `${POLICIES}/${tied.id}/rules`, { expectedVersion: tied.version, categoryId: w.categories.MEALS, gradeId, locationId, limitAmount: '900', receiptRequired: true });
    expect(settled.statusCode, settled.body).toBe(201);
    expect((await policy(w, tied.id)).warnings.map((x) => x.code)).not.toContain('TIED_RULES');
    // In other categories a grade rule and a location rule do not tie at all.
    const apart = await draft(w, 'DEFAULT', { effectiveFrom: '2031-01-01' }, [
      { category: 'MEALS', limit: '700', gradeId },
      { category: 'OTHER', limit: '800', locationId },
    ]);
    expect(apart.warnings).toEqual([]);
  });

  it('ends the earlier revision of its code on its first day and refuses any other overlap', async () => {
    const w = await world();
    const successor = await draft(w, 'DEFAULT', { effectiveFrom: '2031-01-01' }, [{ category: 'OTHER', limit: '100' }]);
    expect(successor.revision).toBe(2);
    expect(successor.warnings).toEqual([]);
    expect((await activate(w.activator, successor.id, successor.version)).json()).toMatchObject({ state: 'ACTIVE', closed: [w.seeded.id] });
    expect(await policy(w, w.seeded.id)).toMatchObject({ state: 'ACTIVE', effectiveTo: '2031-01-01' });
    const closing = await h.one<{ action: string; actor_user_id: string }>(`select action, actor_user_id from audit_event where resource_code = 'expense_policy' and record_key = $1 and action = 'CLOSE'`, [w.seeded.id]);
    expect(closing.actor_user_id).toBe(w.activator.user);

    // A revision of another code in force in the same period would make every line of the overlap ambiguous.
    const otherCode = await draft(w, newCode(), { effectiveFrom: '2030-06-01', effectiveTo: '2030-07-01' }, [{ category: 'OTHER', limit: '100' }]);
    expect(otherCode.warnings.map((x) => x.code)).toEqual(['OVERLAPPING']);
    const refused = await activate(w.activator, otherCode.id, otherCode.version);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'POLICY_OVERLAP', details: { revisions: [{ policyId: w.seeded.id, code: 'DEFAULT', revision: 1 }] } });
    // So would an earlier start under the same code than a revision already in force after it.
    const earlier = await draft(w, 'DEFAULT', { effectiveFrom: '2030-12-01' }, [{ category: 'OTHER', limit: '100' }]);
    const closedAgain = await activate(w.activator, earlier.id, earlier.version);
    expect(closedAgain.json()).toMatchObject({ error: 'POLICY_OVERLAP', details: { revisions: [{ policyId: successor.id }] } });
    expect((await policy(w, w.seeded.id)).effectiveTo).toBe('2031-01-01');
    // A period that overlaps nothing is free, under any code.
    const elsewhere = await activated(w, newCode(), { effectiveFrom: '1990-01-01', effectiveTo: '1995-01-01' }, [{ category: 'OTHER', limit: '100' }]);
    expect(elsewhere.state).toBe('ACTIVE');
  });

  it('never ends a revision before a date a submitted claim already used it for (POLICY_IN_USE), changing nothing', async () => {
    const w = await world();
    const claim = await submitted(w, [await line(w, 'OTHER', '50', daysAgo(3))]);
    expect(await pinnedPolicy(claim)).toBe(w.seeded.id);
    expect((await policy(w, w.seeded.id)).lastUsedOn).toBe(daysAgo(3));

    const backDated = await draft(w, 'DEFAULT', { effectiveFrom: daysAgo(3) }, [{ category: 'OTHER', limit: '100' }]);
    const refused = await activate(w.activator, backDated.id, backDated.version);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'POLICY_IN_USE', details: { policyId: w.seeded.id, lastUsedOn: daysAgo(3) } });
    expect(await policy(w, backDated.id)).toMatchObject({ state: 'DRAFT' });
    expect((await policy(w, w.seeded.id)).effectiveTo).toBeNull();

    // The day after the last one used is free.
    const next = await h.call(w.author, 'PATCH', `${POLICIES}/${backDated.id}`, { expectedVersion: backDated.version, effectiveFrom: daysAgo(2) });
    expect((await activate(w.activator, backDated.id, next.json().version)).statusCode).toBe(200);
    expect((await policy(w, w.seeded.id)).effectiveTo).toBe(daysAgo(2));
  });

  it('two activations that overlap, at the same moment: one wins and the other is refused', async () => {
    const w = await world();
    const a = await draft(w, newCode(), { effectiveFrom: '2030-01-01', effectiveTo: '2031-01-01' }, [{ category: 'OTHER', limit: '100' }]);
    const b = await draft(w, newCode(), { effectiveFrom: '2030-06-01', effectiveTo: '2031-06-01' }, [{ category: 'OTHER', limit: '100' }]);
    // Keep both apart from the provisioned revision, which would refuse them whatever the race did.
    await h.db.query(`update expense_policy set effective_to = '2029-01-01' where id = $1`, [w.seeded.id]);
    const results = await Promise.all([activate(w.activator, a.id, a.version), activate(w.activator, b.id, b.version)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.statusCode === 409)!.json().error).toBe('POLICY_OVERLAP');
    const states = [(await policy(w, a.id)).state, (await policy(w, b.id)).state].sort();
    expect(states).toEqual(['ACTIVE', 'DRAFT']);
  });
});

describe('retirement', () => {
  /** The company's business date, as the rule reads it: at some hours it is a day ahead of the UTC calendar date. */
  const businessDate = async (w: World, plusDays = 0) => (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, now()) + $2::int, 'YYYY-MM-DD') as d`, [w.c.id, plusDays])).d;

  it('needs a reason and a date from today on, within its period; it never reaches back', async () => {
    const w = await world();
    const today = await businessDate(w);
    expect((await retire(w.activator, w.seeded.id, w.seeded.version, await businessDate(w, -1))).json().error).toBe('BACKDATED_RETIREMENT');
    expect((await h.call(w.activator, 'POST', `${POLICIES}/${w.seeded.id}/retire`, { expectedVersion: w.seeded.version, effectiveTo: today })).statusCode).toBe(400);
    expect((await h.call(w.activator, 'POST', `${POLICIES}/${w.seeded.id}/retire`, { expectedVersion: w.seeded.version, effectiveTo: today, reason: '   ' })).statusCode).toBe(400);
    expect((await retire(w.activator, w.seeded.id, w.seeded.version + 5, today)).json().error).toBe('STALE_VERSION');
    const bounded = await activated(w, newCode(), { effectiveFrom: '1990-01-01', effectiveTo: '1995-01-01' }, [{ category: 'OTHER', limit: '100' }]);
    expect((await retire(w.activator, bounded.id, bounded.version, today)).json().error).toBe('INVALID_PERIOD');
    expect((await retire(w.employee, w.seeded.id, w.seeded.version, today)).statusCode).toBe(403);
    const reason = (await retire(w.activator, w.seeded.id, w.seeded.version, today, 'Synthetic: policy ended')).json();
    expect(reason).toMatchObject({ state: 'RETIRED', effectiveTo: today });
    expect((await h.one<{ reason: string }>(`select reason from audit_event where resource_code = 'expense_policy' and record_key = $1 and action = 'RETIRE'`, [w.seeded.id])).reason).toBe('Synthetic: policy ended');
    expect((await retire(w.activator, w.seeded.id, w.seeded.version + 1, today)).json().error).toBe('INVALID_STATE');
  });

  it('a retired revision still judges earlier expense dates, and nothing from its end on', async () => {
    const w = await world();
    const today = await businessDate(w);
    expect((await retire(w.activator, w.seeded.id, w.seeded.version, today)).statusCode).toBe(200);
    const before = await submitted(w, [await line(w, 'OTHER', '60', daysAgo(2))]);
    expect(await pinnedPolicy(before)).toBe(w.seeded.id);
    const after = await newClaim(w, [await line(w, 'OTHER', '60', today)]);
    expect((await submit(w, after)).json().error).toBe('POLICY_NOT_FOUND');
  });

  it('a retirement cannot cut off a date already used', async () => {
    const w = await world();
    const today = await businessDate(w);
    await submitted(w, [await line(w, 'OTHER', '70', today)]);
    expect((await retire(w.activator, w.seeded.id, w.seeded.version, today)).json().error).toBe('POLICY_IN_USE');
    expect((await policy(w, w.seeded.id)).state).toBe('ACTIVE');
    expect((await retire(w.activator, w.seeded.id, w.seeded.version, await businessDate(w, 1))).statusCode).toBe(200);
  });

  it('a revision that would never have started leaves force entirely', async () => {
    const w = await world();
    await h.db.query(`update expense_policy set effective_to = '2039-01-01' where id = $1`, [w.seeded.id]);
    const later = await activated(w, newCode(), { effectiveFrom: '2040-01-01' }, [{ category: 'OTHER', limit: '100' }]);
    const res = await retire(w.activator, later.id, later.version, await businessDate(w));
    expect(res.json()).toMatchObject({ state: 'RETIRED', effectiveTo: null });
    // Out of force: its period no longer stands in anyone's way.
    const again = await activated(w, newCode(), { effectiveFrom: '2040-01-01' }, [{ category: 'OTHER', limit: '100' }]);
    expect(again.state).toBe('ACTIVE');
  });
});

describe('frozen in the database, whatever the path (DB048; FR-078)', () => {
  let w: World;
  let frozen: Policy;
  beforeAll(async () => {
    w = await world();
    frozen = await policy(w, w.seeded.id);
    await submitted(w, [await line(w, 'OTHER', '80', daysAgo(1))]);
  });

  it('the values of an activated revision never change', async () => {
    for (const set of [`high_value_threshold = 1`, `submission_window_days = 1`, `currency_code = 'USD'`, `effective_from = '2001-01-01'`, `code = 'RENAMED'`, `revision = 99`]) {
      await expectSqlError(h.db.query(`update expense_policy set ${set} where id = $1`, [frozen.id]), CHECK_VIOLATION);
    }
    await expectSqlError(h.db.query(`update expense_policy set state = 'DRAFT' where id = $1`, [frozen.id]), CHECK_VIOLATION);
  });

  it('nor do its rules', async () => {
    const rule = frozen.rules[0]!;
    await expectSqlError(h.db.query(`update expense_policy_rule set limit_amount = 1 where id = $1`, [rule.id]), CHECK_VIOLATION);
    await expectSqlError(h.db.query(`update expense_policy_rule set receipt_required = not receipt_required where id = $1`, [rule.id]), CHECK_VIOLATION);
    await expectSqlError(h.db.query(`delete from expense_policy_rule where id = $1`, [rule.id]), CHECK_VIOLATION);
    await expectSqlError(
      h.db.query(`insert into expense_policy_rule (company_id, policy_id, category_id, grade_id, limit_amount, receipt_required) values ($1, $2, $3, $4, 1, true)`, [w.c.id, frozen.id, w.categories.OTHER, await master(w, 'grade')]),
      CHECK_VIOLATION,
    );
  });

  it('its period may only end earlier, and never before a used date', async () => {
    await expectSqlError(h.db.query(`update expense_policy set effective_to = $2 where id = $1`, [frozen.id, daysAgo(1)]), CHECK_VIOLATION);
    await expectSqlError(h.db.query(`update expense_policy set state = 'RETIRED', effective_to = null where id = $1`, [frozen.id]), CHECK_VIOLATION);
    await h.db.query(`update expense_policy set effective_to = '2050-01-01' where id = $1`, [frozen.id]);
    await expectSqlError(h.db.query(`update expense_policy set effective_to = '2051-01-01' where id = $1`, [frozen.id]), CHECK_VIOLATION);
    await expectSqlError(h.db.query(`update expense_policy set effective_to = null where id = $1`, [frozen.id]), CHECK_VIOLATION);
  });

  it('a retired revision stays retired, one without an end stays out of force', async () => {
    const c = await world();
    await h.db.query(`update expense_policy set state = 'RETIRED', effective_to = null where id = $1`, [c.seeded.id]);
    await expectSqlError(h.db.query(`update expense_policy set state = 'ACTIVE' where id = $1`, [c.seeded.id]), CHECK_VIOLATION);
    await expectSqlError(h.db.query(`update expense_policy set effective_to = '2050-01-01' where id = $1`, [c.seeded.id]), CHECK_VIOLATION);
  });

  it('a second revision in force in an overlapping period is refused by any path', async () => {
    const d = await draft(w, newCode(), { effectiveFrom: '2030-01-01' }, [{ category: 'OTHER', limit: '100' }]);
    await expectSqlError(h.db.query(`update expense_policy set state = 'ACTIVE', activated_by = $2, activated_at = now() where id = $1`, [d.id, w.activator.user]), CHECK_VIOLATION);
  });

  it('whoever last edited a draft does not activate it by any path', async () => {
    const d = await draft(w, newCode(), { effectiveFrom: '1990-01-01', effectiveTo: '1991-01-01' }, [{ category: 'OTHER', limit: '100' }]);
    const editor = await h.actor(w.c, 'HR_ADMINISTRATOR');
    await h.db.query(`update expense_policy set updated_by = $2 where id = $1`, [d.id, editor.user]);
    await expectSqlError(h.db.query(`update expense_policy set state = 'ACTIVE', activated_by = $2, activated_at = now() where id = $1`, [d.id, editor.user]), CHECK_VIOLATION);
  });
});

describe('submission judged by the policy of the expense date (FR-078, BR-019, DF06)', () => {
  it('applies the revision in force on each expense date, and flags against its own limit', async () => {
    const w = await world();
    const r2 = await activated(w, 'DEFAULT', { effectiveFrom: daysAgo(5) }, [{ category: 'MEALS', limit: '200' }]);
    // 300 is within revision 1's 1,000 before the change and over revision 2's 200 after it.
    const earlier = await submitted(w, [await line(w, 'MEALS', '300', daysAgo(7))]);
    expect(await pinnedPolicy(earlier)).toBe(w.seeded.id);
    expect((await claimOf(w, earlier)).lines[0]).toMatchObject({ exceptionFlags: [], appliedLimit: '1000.0000' });
    const later = await newClaim(w, [await line(w, 'MEALS', '300', daysAgo(3))]);
    expect((await submit(w, later)).json()).toMatchObject({ error: 'EXCEPTION_REASON_REQUIRED', details: { lines: [{ line: 1, flags: ['OVER_LIMIT'] }] } });
    const within = await submitted(w, [await line(w, 'MEALS', '150', daysAgo(2))]);
    expect(await pinnedPolicy(within)).toBe(r2.id);
    expect((await claimOf(w, within)).revisions).toEqual([expect.objectContaining({ revision: 1, policyCode: 'DEFAULT', policyRevision: 2 })]);
  });

  it('lines under two revisions are ambiguous; a line no revision covers is refused even beside a covered one', async () => {
    const w = await world();
    await activated(w, 'DEFAULT', { effectiveFrom: daysAgo(5) }, [{ category: 'OTHER', limit: '500' }]);
    const across = await newClaim(w, [await line(w, 'OTHER', '10', daysAgo(7)), await line(w, 'OTHER', '11', daysAgo(3))]);
    expect((await submit(w, across)).json().error).toBe('POLICY_AMBIGUOUS');
    expect((await claimOf(w, across)).state).toBe('DRAFT');

    const v = await world();
    await h.db.query(`update expense_policy set state = 'RETIRED', effective_to = $2 where id = $1`, [v.seeded.id, daysAgo(5)]);
    await activated(v, 'DEFAULT', { effectiveFrom: daysAgo(3) }, [{ category: 'OTHER', limit: '500' }]);
    // The gap: daysAgo(4) has no revision, whatever the other line's date has.
    const gap = await newClaim(v, [await line(v, 'OTHER', '10', daysAgo(4)), await line(v, 'OTHER', '11', daysAgo(2))]);
    expect((await submit(v, gap)).json()).toMatchObject({ error: 'POLICY_NOT_FOUND', details: { lines: [1] } });
  });

  it('the rule naming most of grade and location wins; without a matching rule the category is not eligible', async () => {
    const w = await world();
    const [g1, g2, l1] = [await master(w, 'grade'), await master(w, 'grade'), await master(w, 'location')];
    await activated(w, 'DEFAULT', { effectiveFrom: daysAgo(5) }, [
      { category: 'MEALS', limit: '100' },
      { category: 'MEALS', limit: '200', gradeId: g1 },
      { category: 'MEALS', limit: '400', gradeId: g1, locationId: l1 },
      { category: 'TRAVEL', limit: '300', gradeId: g2 },
      { category: 'OTHER', limit: '500', locationId: l1, receiptRequired: false },
    ]);
    const limitOn = async (category: string, amount: string, extra: Record<string, unknown> = {}) => {
      const id = await newClaim(w, [await line(w, category, amount, daysAgo(2), extra)]);
      const res = await submit(w, id);
      return { res, id };
    };
    // No classification: only the company-wide rule applies.
    await placed(w, null, null);
    expect((await limitOn('MEALS', '150')).res.json().details.lines[0].flags).toEqual(['OVER_LIMIT']);
    expect((await limitOn('TRAVEL', '10')).res.json()).toMatchObject({ error: 'CLAIM_INVALID', details: { errors: [{ line: 1, code: 'CATEGORY_NOT_ELIGIBLE' }] } });
    // A grade rule beats the company-wide one, and a rule for the same grade and location beats both.
    await placed(w, g1, null);
    const byGrade = await limitOn('MEALS', '150');
    expect(byGrade.res.statusCode, byGrade.res.body).toBe(200);
    expect((await claimOf(w, byGrade.id)).lines[0].appliedLimit).toBe('200.0000');
    await placed(w, g1, l1);
    const byBoth = await limitOn('MEALS', '350', { expenseDate: daysAgo(1) });
    expect(byBoth.res.statusCode, byBoth.res.body).toBe(200);
    expect((await claimOf(w, byBoth.id)).lines[0].appliedLimit).toBe('400.0000');
    // A location rule that needs no receipt: its absence raises no flag.
    const noReceipt = await limitOn('OTHER', '40', { receipt: undefined });
    expect(noReceipt.res.statusCode, noReceipt.res.body).toBe(200);
    expect((await claimOf(w, noReceipt.id)).lines[0].exceptionFlags).toEqual([]);
  });

  it('uses the classification on the expense date, not today', async () => {
    const w = await world();
    const [g1, g2] = [await master(w, 'grade'), await master(w, 'grade')];
    await activated(w, 'DEFAULT', { effectiveFrom: daysAgo(20) }, [
      { category: 'MEALS', limit: '200', gradeId: g1 },
      { category: 'MEALS', limit: '900', gradeId: g2 },
    ]);
    // Grade G1 until ten days ago, G2 since.
    await h.db.query(`update employment_assignment set grade_id = $2, effective_to = $3 where employee_id = $1 and effective_to is null`, [w.employeeId, g1, daysAgo(10)]);
    await h.db.query(
      `insert into employment_assignment (company_id, employee_id, department_id, location_id, designation_id, grade_id, effective_from)
       select company_id, employee_id, department_id, location_id, designation_id, $2::uuid, $3::date from employment_assignment where employee_id = $1 and effective_to = $3::date`,
      [w.employeeId, g2, daysAgo(10)],
    );
    const thenId = await newClaim(w, [await line(w, 'MEALS', '500', daysAgo(15))]);
    expect((await submit(w, thenId)).json()).toMatchObject({ error: 'EXCEPTION_REASON_REQUIRED', details: { lines: [{ line: 1, flags: ['OVER_LIMIT'] }] } });
    const nowId = await submitted(w, [await line(w, 'MEALS', '500', daysAgo(5))]);
    expect((await claimOf(w, nowId)).lines[0].appliedLimit).toBe('900.0000');
  });

  it('two equally specific rules block with POLICY_AMBIGUOUS, and no approval is created', async () => {
    const w = await world();
    const [g1, l1] = [await master(w, 'grade'), await master(w, 'location')];
    const tied = await draft(w, 'DEFAULT', { effectiveFrom: daysAgo(5) }, [
      { category: 'MEALS', limit: '700', gradeId: g1 },
      { category: 'MEALS', limit: '800', locationId: l1 },
      { category: 'OTHER', limit: '500' },
    ]);
    // Activation refuses this (above); the submission must hold whatever path activated it.
    await h.db.query(`update expense_policy set effective_to = $2 where id = $1`, [w.seeded.id, daysAgo(5)]);
    await h.db.query(`update expense_policy set state = 'ACTIVE', activated_by = $2, activated_at = now() where id = $1`, [tied.id, w.activator.user]);
    await placed(w, g1, l1);
    const id = await newClaim(w, [await line(w, 'OTHER', '10', daysAgo(2)), await line(w, 'MEALS', '10', daysAgo(2))]);
    const res = await submit(w, id);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: 'POLICY_AMBIGUOUS', details: { lines: [2] } });
    expect((await claimOf(w, id)).state).toBe('DRAFT');
    const tx = (await h.one<{ transaction_id: string }>(`select transaction_id from expense_claim where id = $1`, [id])).transaction_id;
    expect((await h.db.query(`select 1 from approval_instance where transaction_id = $1`, [tx])).rowCount).toBe(0);
    // Matching only one of them is no tie.
    await placed(w, g1, w.c.loc);
    expect((await submit(w, id)).statusCode).toBe(200);
    expect((await claimOf(w, id)).lines[1].appliedLimit).toBe('700.0000');
  });

  it('later policy changes leave a claim as it was judged, through to its final decision', async () => {
    const w = await world();
    const id = await submitted(w, [await line(w, 'OTHER', '600', daysAgo(6))]);
    const flagged = (await claimOf(w, id)).lines[0];
    expect(flagged).toMatchObject({ appliedLimit: '1000.0000', exceptionFlags: [] });
    // A later revision with a threshold below this claim's total, and limits below its amount, changes nothing about it.
    await activated(w, 'DEFAULT', { effectiveFrom: daysAgo(5), highValueThreshold: '100' }, [{ category: 'OTHER', limit: '1' }]);
    const tx = (await h.one<{ transaction_id: string }>(`select transaction_id from expense_claim where id = $1`, [id])).transaction_id;
    const taskOf = async (a: TestActor) => ((await h.call(a, 'GET', '/v1/expense/tasks')).json().items as { taskId: string; transactionId: string }[]).find((t) => t.transactionId === tx)!.taskId;
    expect((await h.call(w.manager, 'POST', `/v1/expense/tasks/${await taskOf(w.manager)}/decision`, { idempotencyKey: uniq('pol-key-'), decision: 'APPROVE' })).json().state).toBe('FINANCE_PENDING');
    const decided = await h.call(w.fin, 'POST', `/v1/expense/tasks/${await taskOf(w.fin)}/decision`, { idempotencyKey: uniq('pol-key-'), decision: 'APPROVE', lines: [{ lineId: flagged.id, allowedAmount: '600' }] });
    expect(decided.json()).toMatchObject({ state: 'APPROVED', approvedAmount: '600.0000' });
    expect(await claimOf(w, id, w.employee)).toMatchObject({ revisions: [expect.objectContaining({ policyRevision: 1 })], lines: [expect.objectContaining({ appliedLimit: '1000.0000', approvedAmount: '600.0000' })] });
  });

  it('closing a revision and a submission on its date, in both orders: the claim is judged by the revision that covers it', async () => {
    const date = daysAgo(1);
    for (const submitFirst of [true, false]) {
      const w = await world();
      const lockKey = `expense:policy:${w.c.id}`;
      const predecessor = w.seeded;
      const successor = await draft(w, 'DEFAULT', { effectiveFrom: date }, [{ category: 'OTHER', limit: '500' }]);
      const claim = await newClaim(w, [await line(w, 'OTHER', '30', date)]);
      await h.db.query(`select pg_advisory_lock(hashtextextended($1, 0))`, [lockKey]);
      const first = submitFirst ? submit(w, claim) : activate(w.activator, successor.id, successor.version);
      await waitForAdvisory(1);
      const second = submitFirst ? activate(w.activator, successor.id, successor.version) : submit(w, claim);
      await waitForAdvisory(2);
      await h.db.query(`select pg_advisory_unlock(hashtextextended($1, 0))`, [lockKey]);
      const [a, b] = await Promise.all([first, second]);
      const [sub, act] = submitFirst ? [a, b] : [b, a];
      expect(sub.statusCode, sub.body).toBe(200);
      if (submitFirst) {
        // The claim used the predecessor for that date, so the predecessor cannot end by then.
        expect(act.json().error).toBe('POLICY_IN_USE');
        expect(await pinnedPolicy(claim)).toBe(predecessor.id);
        expect((await policy(w, predecessor.id)).effectiveTo).toBeNull();
      } else {
        expect(act.statusCode, act.body).toBe(200);
        expect(await pinnedPolicy(claim)).toBe(successor.id);
        expect((await policy(w, predecessor.id)).effectiveTo).toBe(date);
      }
    }
  });
});

/** The app's connections waiting on an advisory lock (the test holds the company's policy key while both requests start). */
async function waitForAdvisory(min: number) {
  for (let i = 0; i < 400; i++) {
    const r = await h.db.query<{ n: number }>(`select count(*)::int as n from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and wait_event_type = 'Lock' and wait_event = 'advisory'`);
    if (r.rows[0]!.n >= min) return;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`timeout waiting for ${min} advisory waiters`);
}

describe('categories (DB047)', () => {
  let w: World;
  beforeAll(async () => {
    w = await world();
  });

  it('HR adds a category with its limit basis; a claimant can then use it under a rule', async () => {
    const code = newCode();
    const created = await h.call(w.author, 'POST', '/v1/expense/categories', { code, name: 'Synthetic parking', limitBasis: 'PER_LINE' });
    expect(created.statusCode, created.body).toBe(201);
    expect((await h.call(w.author, 'POST', '/v1/expense/categories', { code, name: 'Again', limitBasis: 'PER_DAY' })).json().error).toBe('CATEGORY_EXISTS');
    expect((await h.call(w.author, 'POST', '/v1/expense/categories', { code: newCode(), name: 'x', limitBasis: 'PER_MONTH' })).statusCode).toBe(400);
    expect((await h.call(w.employee, 'POST', '/v1/expense/categories', { code: newCode(), name: 'x', limitBasis: 'PER_LINE' })).statusCode).toBe(403);
    expect((await h.call(w.employee, 'GET', '/v1/expense/categories')).json().items).toContainEqual({ code, name: 'Synthetic parking', limitBasis: 'PER_LINE' });

    // Without a rule in the revision in force it is not eligible (DF06 "unset never means unlimited").
    const claim = await newClaim(w, [await line(w, code, '10', daysAgo(2))]);
    expect((await submit(w, claim)).json()).toMatchObject({ error: 'CLAIM_INVALID', details: { errors: [{ line: 1, code: 'CATEGORY_NOT_ELIGIBLE' }] } });

    const version = created.json().version as number;
    const off = await h.call(w.author, 'PATCH', `/v1/expense/categories/${created.json().id}`, { expectedVersion: version, active: false });
    expect(off.json()).toEqual({ id: created.json().id, version: version + 1 });
    expect((await h.call(w.author, 'PATCH', `/v1/expense/categories/${created.json().id}`, { expectedVersion: version, active: true })).json().error).toBe('STALE_VERSION');
    expect((await h.call(w.employee, 'GET', '/v1/expense/categories')).json().items.map((c: { code: string }) => c.code)).not.toContain(code);
    expect((await h.call(w.employee, 'POST', '/v1/expense/claims', { purpose: 'x', currency: 'INR', lines: [await line(w, code, '10', daysAgo(2))] })).json().error).toBe('INVALID_REFERENCE');
    expect((await h.call(w.author, 'GET', '/v1/expense/category-maintenance')).json().items).toContainEqual(expect.objectContaining({ code, active: false }));
    // A rule cannot name it either; the policy form no longer offers it.
    const p = await draft(w, 'DEFAULT', { effectiveFrom: '2032-01-01' }, []);
    expect((await h.call(w.author, 'POST', `${POLICIES}/${p.id}/rules`, { expectedVersion: p.version, categoryId: created.json().id, limitAmount: '5', receiptRequired: true })).json().error).toBe('INVALID_REFERENCE');
    expect((await h.call(w.author, 'GET', '/v1/expense/policy-options')).json().categories.map((c: { code: string }) => c.code)).not.toContain(code);
  });

  it('a category keeps its code and limit basis, so a limit keeps its meaning', async () => {
    await expectSqlError(h.db.query(`update expense_category set limit_basis = 'PER_LINE' where company_id = $1 and code = 'MEALS'`, [w.c.id]), CHECK_VIOLATION);
    await expectSqlError(h.db.query(`update expense_category set code = 'RENAMED' where company_id = $1 and code = 'MEALS'`, [w.c.id]), CHECK_VIOLATION);
  });
});
