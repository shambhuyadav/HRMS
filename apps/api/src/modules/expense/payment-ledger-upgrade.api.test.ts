// Applying 0088 and 0096 to a database that already holds expense payments (B5 "reject existing duplicates/orphans
// before adding constraints"; DF07). An upgrade test builds the schema 0088 starts from and fills it with synthetic rows
// straight into the tables, with triggers off, as the earlier service left them. Those rows keep their ledger; a row
// breaking a money rule stops the migration and changes nothing; a past duty is not judged again, while every further
// act on the row is. Synthetic data only.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../../../../db/migrate.js';
import { CHECK_VIOLATION, expectSqlError } from '../../../../../db/tests/fixtures.js';
import { startEmptyTestDatabase, type TestDatabase } from '../../../../../db/tests/test-database.js';

const LEDGER = '0089';
const CLEARANCE = '0097';

let old: TestDatabase;
let db: pg.Client;

const company = randomUUID();
const payee = randomUUID();
const finance = randomUUID();
const approver = randomUUID();
const preparer = randomUUID();
const releaser = randomUUID();

/** Rows the earlier schema's triggers would refuse or need parents for go in with triggers off. */
const withoutTriggers = async (work: () => Promise<void>) => {
  await db.query(`set session_replication_role = replica`);
  try {
    await work();
  } finally {
    await db.query(`set session_replication_role = origin`);
  }
};

interface SeededClaim {
  id: string;
  revision: string;
  obligation: string;
}

async function seedClaim(approved: string, paymentState: string, overrides: { approvedBy?: string; currentRevision?: number } = {}): Promise<SeededClaim> {
  const id = randomUUID();
  const revision = randomUUID();
  const obligation = randomUUID();
  await db.query(
    `insert into expense_claim (id, company_id, employee_id, transaction_id, purpose, currency_code, current_revision, state, payment_state)
     values ($1, $2, $3, $4, 'Upgrade check (synthetic)', 'INR', $5, 'APPROVED', $6)`,
    [id, company, payee, randomUUID(), overrides.currentRevision ?? 1, paymentState],
  );
  await db.query(`insert into expense_revision (id, company_id, claim_id, revision, policy_id, currency_code, submitted_at, submitted_by) values ($1, $2, $3, 1, $4, 'INR', now(), $5)`, [
    revision,
    company,
    id,
    randomUUID(),
    finance,
  ]);
  await db.query(`insert into expense_obligation (id, company_id, claim_id, revision_id, employee_id, approved_amount, currency_code, approved_by) values ($1, $2, $3, $4, $5, $6::numeric, 'INR', $7)`, [
    obligation,
    company,
    id,
    revision,
    payee,
    approved,
    overrides.approvedBy ?? approver,
  ]);
  return { id, revision, obligation };
}

async function seedInstruction(obligation: string, amount: string, state: string, opts: { prepared?: string; released?: string; allocated?: string } = {}): Promise<{ id: string; allocation: string }> {
  const id = randomUUID();
  const batch = randomUUID();
  const allocation = randomUUID();
  await db.query(`insert into payment_batch (id, company_id, transaction_id, state, prepared_by, currency_code) values ($1, $2, $3, 'READY', $4, 'INR')`, [batch, company, randomUUID(), opts.prepared ?? preparer]);
  await db.query(
    `insert into payment_instruction (id, company_id, batch_id, employee_id, amount, currency_code, state, idempotency_key, payment_date, released_by)
     values ($1, $2, $3, $4, $5::numeric, 'INR', $6, $7, current_date, $8)`,
    [id, company, batch, payee, amount, state, `upgrade-key-${id}`, ['RELEASED', 'CONFIRMED', 'FAILED'].includes(state) ? (opts.released ?? releaser) : null],
  );
  await db.query(`insert into payment_allocation (id, company_id, instruction_id, obligation_id, employee_id, currency_code, amount) values ($1, $2, $3, $4, $5, 'INR', $6::numeric)`, [
    allocation,
    company,
    id,
    obligation,
    payee,
    opts.allocated ?? amount,
  ]);
  return { id, allocation };
}

async function seedEvent(instruction: string, kind: string, amount: string, opts: { reverses?: string; by?: string } = {}): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into payment_event (id, company_id, instruction_id, event_key, event_kind, amount, reverses_event_id, recorded_by, reason)
     values ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9)`,
    [id, company, instruction, `upgrade-event-${id}`, kind, amount, opts.reverses ?? null, opts.by ?? releaser, kind === 'REVERSED' ? 'Bank return (synthetic)' : null],
  );
  return id;
}

const ledger = async (claim: string) =>
  (
    await db.query<{ net_paid: string; pending: string; payment_state: string }>(
      `select l.net_paid::numeric(19,2)::text as net_paid, l.pending::numeric(19,2)::text as pending, c.payment_state
         from expense_obligation_ledger l join expense_claim c on c.company_id = l.company_id and c.id = l.claim_id where l.claim_id = $1`,
      [claim],
    )
  ).rows[0];
const applied = async () => (await db.query<{ filename: string }>(`select filename from schema_migration where filename like '0088%'`)).rows.length;
const hasAllocationColumn = async () => (await db.query(`select 1 from information_schema.columns where table_name = 'payment_event' and column_name = 'allocation_id'`)).rowCount === 1;

let ordinary: SeededClaim;
let ordinaryPaid: { id: string; allocation: string };
let reversal: string;
let confirmation: string;
let approverReleased: { id: string; allocation: string };
let flaggedLine: string;
const before = {} as { ordinary: Awaited<ReturnType<typeof ledger>> };

beforeAll(async () => {
  const empty = await startEmptyTestDatabase();
  if (!empty) throw new Error('An upgrade test needs TEST_PG_ADMIN_URL');
  old = empty;
  db = old.client;
  await migrate(db, { before: '0088' });
  await withoutTriggers(async () => {
    // Approve 1000, pay 600, reverse 100, a live 300 and 50, and a failed 40: net 500 and pending 350 (DF07).
    ordinary = await seedClaim('1000', 'PART_PAID');
    ordinaryPaid = await seedInstruction(ordinary.obligation, '600', 'CONFIRMED');
    confirmation = await seedEvent(ordinaryPaid.id, 'CONFIRMED', '600');
    reversal = await seedEvent(ordinaryPaid.id, 'REVERSED', '100', { reverses: confirmation });
    await seedInstruction(ordinary.obligation, '300', 'PREPARED');
    await seedInstruction(ordinary.obligation, '50', 'RELEASED');
    const failed = await seedInstruction(ordinary.obligation, '40', 'FAILED');
    await seedEvent(failed.id, 'FAILED', '40');

    // A payment released and confirmed by its entitlement approver, and one by someone linked to the employee only later.
    const paidByApprover = await seedClaim('70', 'PAID');
    approverReleased = await seedInstruction(paidByApprover.obligation, '70', 'CONFIRMED', { released: approver });
    await seedEvent(approverReleased.id, 'CONFIRMED', '70', { by: approver });
    const later = randomUUID();
    const paidByLaterLinked = await seedClaim('80', 'PAID');
    const laterPaid = await seedInstruction(paidByLaterLinked.obligation, '80', 'CONFIRMED', { released: later });
    await seedEvent(laterPaid.id, 'CONFIRMED', '80', { by: later });
    await db.query(`insert into user_employee_link (company_id, user_id, employee_id, effective_from) values ($1, $2, $3, current_date)`, [company, later, payee]);

    // A zero-entitlement approval and a draft: no obligation at all.
    const zero = randomUUID();
    await db.query(`insert into expense_claim (id, company_id, employee_id, transaction_id, purpose, currency_code, current_revision, state, payment_state) values ($1, $2, $3, $4, 'Zero (synthetic)', 'INR', 1, 'APPROVED', 'NO_PAYABLE_AMOUNT')`, [
      zero,
      company,
      payee,
      randomUUID(),
    ]);
    await db.query(`insert into expense_revision (company_id, claim_id, revision, policy_id, currency_code, submitted_at, submitted_by) values ($1, $2, 1, $3, 'INR', now(), $4)`, [company, zero, randomUUID(), finance]);
    const draft = randomUUID();
    await db.query(`insert into expense_claim (id, company_id, employee_id, transaction_id, purpose, currency_code, current_revision, state, payment_state) values ($1, $2, $3, $4, 'Draft (synthetic)', 'INR', 1, 'DRAFT', 'NOT_APPLICABLE')`, [
      draft,
      company,
      payee,
      randomUUID(),
    ]);
    await db.query(`insert into expense_revision (company_id, claim_id, revision, currency_code) values ($1, $2, 1, 'INR')`, [company, draft]);

    // A flagged line accepted at full amount with no reviewer reason, as 0012 allowed.
    flaggedLine = randomUUID();
    await db.query(
      `insert into expense_line (id, company_id, revision_id, sequence, category_id, expense_date, merchant, gross_amount, claimed_amount, description, exception_flags, exception_reason, fingerprint)
       values ($1, $2, $3, 1, $4, current_date, 'Synthetic Merchant', 70, 70, 'Upgrade check (synthetic)', '{OVER_LIMIT}', 'Claimant justification (synthetic)', 'fingerprint')`,
      [flaggedLine, company, paidByApprover.revision, randomUUID()],
    );
    await db.query(`insert into expense_line_decision (company_id, line_id, approval_decision_id, allowed_amount) values ($1, $2, $3, 70)`, [company, flaggedLine, randomUUID()]);
  });
  before.ordinary = await ledger(ordinary.id);
}, 600_000);

afterAll(async () => {
  await old?.stop();
});

describe('a row breaking a money rule stops 0088 and changes nothing (B5)', () => {
  /** Adds the bad rows, expects the migration to fail saying `why`, then removes them. */
  async function stops(why: RegExp, bad: () => Promise<{ table: string; id: string }[]>) {
    let rows: { table: string; id: string }[] = [];
    await withoutTriggers(async () => {
      rows = await bad();
    });
    await expect(migrate(db, { before: LEDGER })).rejects.toThrow(why);
    expect(await applied()).toBe(0);
    expect(await hasAllocationColumn()).toBe(false);
    await withoutTriggers(async () => {
      for (const { table, id } of rows.reverse()) await db.query(`delete from ${table} where id = $1`, [id]);
    });
  }
  /** The rows of one seeded claim with an instruction, for removal. */
  const claimRows = (c: SeededClaim) => [
    { table: 'expense_claim', id: c.id },
    { table: 'expense_revision', id: c.revision },
    { table: 'expense_obligation', id: c.obligation },
  ];
  const instructionRows = (i: { id: string; allocation: string }, batch: string) => [
    { table: 'payment_batch', id: batch },
    { table: 'payment_instruction', id: i.id },
    { table: 'payment_allocation', id: i.allocation },
  ];
  const batchOf = async (instruction: string) => (await db.query<{ batch_id: string }>(`select batch_id from payment_instruction where id = $1`, [instruction])).rows[0]!.batch_id;

  it('a second definitive outcome on an instruction', async () => {
    await stops(/more than one definitive outcome/, async () => [{ table: 'payment_event', id: await seedEvent(ordinaryPaid.id, 'CONFIRMED', '600') }]);
  });

  it('a state saying CONFIRMED with no outcome event', async () => {
    await stops(/state, amount and outcome event disagree/, async () => {
      const c = await seedClaim('10', 'UNPAID');
      const i = await seedInstruction(c.obligation, '10', 'CONFIRMED');
      return [...claimRows(c), ...instructionRows(i, await batchOf(i.id))];
    });
  });

  it('an instruction whose amount differs from its allocation', async () => {
    await stops(/differs from the sum of its allocations/, async () => {
      const c = await seedClaim('10', 'UNPAID');
      const i = await seedInstruction(c.obligation, '10', 'PREPARED', { allocated: '9' });
      return [...claimRows(c), ...instructionRows(i, await batchOf(i.id))];
    });
  });

  it('a payment state its ledger does not derive', async () => {
    await stops(/differs from its ledger/, async () => claimRows(await seedClaim('10', 'PAID')));
  });

  it('a claim whose current revision does not exist (CI02)', async () => {
    await stops(/expense_claim_current_revision_fk/, async () => claimRows(await seedClaim('10', 'UNPAID', { currentRevision: 2 })));
  });

  it('a reversal above what its instruction paid', async () => {
    await stops(/exceed what their allocation was paid/, async () => {
      const c = await seedClaim('20', 'UNPAID');
      const i = await seedInstruction(c.obligation, '10', 'CONFIRMED');
      const confirmed = await seedEvent(i.id, 'CONFIRMED', '10');
      const reversed = await seedEvent(i.id, 'REVERSED', '11', { reverses: confirmed });
      return [...claimRows(c), ...instructionRows(i, await batchOf(i.id)), { table: 'payment_event', id: confirmed }, { table: 'payment_event', id: reversed }];
    });
  });
});

describe('rows the earlier service wrote survive 0088 (DF07)', () => {
  beforeAll(async () => {
    expect((await migrate(db, { before: LEDGER })).some((f) => f.startsWith('0088_'))).toBe(true);
  });

  it('the ledger of each claim is the same as before: approve 1000, pay 600, reverse 100, live 350', async () => {
    expect(before.ordinary).toEqual({ net_paid: '500.00', pending: '350.00', payment_state: 'PART_PAID' });
    expect(await ledger(ordinary.id)).toEqual(before.ordinary);
  });

  it('a recorded reversal is charged to the allocation of its instruction; other events name none', async () => {
    const rows = (await db.query<{ id: string; allocation_id: string | null }>(`select id, allocation_id from payment_event where instruction_id = $1`, [ordinaryPaid.id])).rows;
    expect(rows.find((r) => r.id === reversal)!.allocation_id).toBe(ordinaryPaid.allocation);
    expect(rows.find((r) => r.id === confirmation)!.allocation_id).toBeNull();
  });

  it('payment events are append-only again after the backfill', async () => {
    await expect(db.query(`update payment_event set reason = 'changed' where id = $1`, [reversal])).rejects.toBeDefined();
    expect((await db.query<{ tgenabled: string }>(`select tgenabled from pg_trigger where tgname = 'payment_event_append_only'`)).rows[0]!.tgenabled).toBe('O');
  });

  it('a past duty is not judged again, and the record stays; the next act on it is checked', async () => {
    expect(await ledger((await db.query<{ claim_id: string }>(`select o.claim_id from payment_allocation a join expense_obligation o on o.id = a.obligation_id where a.id = $1`, [approverReleased.allocation])).rows[0]!.claim_id)).toMatchObject({
      net_paid: '70.00',
      payment_state: 'PAID',
    });
    const confirmed = (await db.query<{ id: string }>(`select id from payment_event where instruction_id = $1 and event_kind = 'CONFIRMED'`, [approverReleased.id])).rows[0]!.id;
    await expectSqlError(
      db.query(
        `insert into payment_event (company_id, instruction_id, allocation_id, event_key, event_kind, amount, reverses_event_id, recorded_by, reason)
         values ($1, $2, $3, 'upgrade-next-act', 'REVERSED', 1, $4, $5, 'Bank return (synthetic)')`,
        [company, approverReleased.id, approverReleased.allocation, confirmed, approver],
      ),
      CHECK_VIOLATION,
    );
  });
});

describe('0096 on rows already recorded (FR-075)', () => {
  it('an earlier decision on a flagged line stays as it was, and a new one needs its reason', async () => {
    const applying = await migrate(db, { before: CLEARANCE });
    expect(applying.some((f) => f.startsWith('0096_'))).toBe(true);
    const kept = (await db.query<{ allowed_amount: string; exception_reason: string | null }>(`select allowed_amount::numeric(19,2)::text as allowed_amount, exception_reason from expense_line_decision where line_id = $1`, [flaggedLine])).rows;
    expect(kept).toEqual([{ allowed_amount: '70.00', exception_reason: null }]);
    const permission = await db.query(`select 1 from permission where resource = 'expense' and action = 'read' and field_group = 'reason'`);
    expect(permission.rowCount).toBe(1);
  });
});
