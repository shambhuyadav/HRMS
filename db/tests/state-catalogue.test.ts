// ZT10 (state and revision integrity), CI12, CI15: walks the real transaction_state and transaction_transition catalogue, every
// registered kind and every pair of its states, so a later kind is covered without touching this file. Each refusal names the
// guard's own message, and the same write then succeeds with that one guard disabled, so nothing else can be doing the refusing.
// (A decision on a superseded revision is proved in workflow-constraints.test.ts, "rejects a decision on a superseded revision".)
// This file's database is its own clone. The root walk removes the module rules a root has on top of the mirror, because those rules
// need real decisions and evidence, and what is under test here is only whether the root and the transaction can come apart.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertRow, quote, type TableShape, tableShapes } from './catalogue.fixtures.js';
import { CHECK_VIOLATION } from './fixtures.js';
import { startTestDatabase, type TestDatabase } from './test-database.js';

interface Kind {
  kind: string;
  root: string;
  states: { state: string; initial: boolean; terminal: boolean }[];
  transitions: { from: string; to: string }[];
}

/**
 * Non-terminal in the catalogue with no way out. Nothing reads transaction_state.terminal to decide anything, so this is harmless
 * as it stands; whether an approved outdoor duty or holiday-work request should be cancellable or simply flagged terminal is
 * left to the owner, like leave_request (whose APPROVED leads to CANCELLED). See the report.
 */
const DEAD_ENDS: Record<string, string[]> = {
  holiday_work: ['APPROVED'],
  outdoor_duty: ['APPROVED'],
};

describe('the transaction catalogue (ZT10; CI12; CI15)', () => {
  let testDb: TestDatabase;
  let db: pg.Client;
  let kinds: Kind[];
  let shapes: Map<string, TableShape>;
  const company = randomUUID();

  beforeAll(async () => {
    testDb = await startTestDatabase();
    db = testDb.client;
    shapes = await tableShapes(db);
    const rows = await db.query<{ kind: string; root_table: string; states: Kind['states']; transitions: Kind['transitions'] | null }>(`
      select tk.kind, tk.root_table,
             (select json_agg(json_build_object('state', s.state, 'initial', s.initial, 'terminal', s.terminal) order by s.state) from transaction_state s where s.kind = tk.kind) as states,
             (select json_agg(json_build_object('from', t.from_state, 'to', t.to_state) order by t.from_state, t.to_state) from transaction_transition t where t.kind = tk.kind) as transitions
        from transaction_kind tk order by tk.kind`);
    kinds = rows.rows.map((r) => ({ kind: r.kind, root: r.root_table, states: r.states ?? [], transitions: r.transitions ?? [] }));
    // A transaction may be written here without its parents; the company itself is the only parent read back.
    await db.query('set session_replication_role = replica');
    await db.query(`insert into company (id, code, name, active) values ($1, 'STATE_WALK', 'Synthetic', true)`, [company]);
    await db.query('set session_replication_role = origin');
  });

  afterAll(async () => {
    await testDb?.stop();
  });

  /** Writes a row that its guards would refuse, for tests about what may happen next. */
  const asReplica = async <T>(write: () => Promise<T>) => {
    await db.query('set session_replication_role = replica');
    try {
      return await write();
    } finally {
      await db.query('set session_replication_role = origin');
    }
  };

  const newTransaction = async (kind: string, state: string, owner: string | null = null) => {
    const id = randomUUID();
    await asReplica(() => db.query(`insert into business_transaction (id, company_id, kind, owner_employee_id, state) values ($1, $2, $3, $4, $5)`, [id, company, kind, owner, state]));
    return id;
  };

  describe('its shape', () => {
    it('holds the registered kinds, each with states and at least one way in', () => {
      expect(kinds.length).toBeGreaterThanOrEqual(34);
      for (const k of kinds) {
        expect(k.states.length, k.kind).toBeGreaterThanOrEqual(2);
        expect(k.states.filter((s) => s.initial).length, k.kind).toBeGreaterThanOrEqual(1);
        expect(k.transitions.length, k.kind).toBeGreaterThanOrEqual(1);
      }
    });

    it('no transition leaves a terminal state, every state can be reached, and only the named states are dead ends', () => {
      const problems: string[] = [];
      for (const k of kinds) {
        const terminal = new Set(k.states.filter((s) => s.terminal).map((s) => s.state));
        const leaving = new Map<string, string[]>();
        for (const t of k.transitions) {
          if (terminal.has(t.from)) problems.push(`${k.kind}: ${t.from} is terminal but leads to ${t.to}`);
          leaving.set(t.from, [...(leaving.get(t.from) ?? []), t.to]);
        }
        const reached = new Set(k.states.filter((s) => s.initial).map((s) => s.state));
        for (let grew = true; grew; ) {
          grew = false;
          for (const s of [...reached]) {
            for (const to of leaving.get(s) ?? []) {
              if (!reached.has(to)) {
                reached.add(to);
                grew = true;
              }
            }
          }
        }
        for (const s of k.states) {
          if (!reached.has(s.state)) problems.push(`${k.kind}: ${s.state} cannot be reached`);
          if (!s.terminal && !leaving.has(s.state) && !(DEAD_ENDS[k.kind] ?? []).includes(s.state)) problems.push(`${k.kind}: ${s.state} is not terminal and has no way out`);
        }
      }
      expect(problems).toEqual([]);
    });

    it('every root is one row per transaction, tied to its kind by a composite key that includes the company', async () => {
      const missing: string[] = [];
      for (const k of kinds) {
        const keyed = await db.query(
          `select 1 from pg_constraint con
            where con.conrelid = to_regclass($1) and con.contype = 'f' and con.confrelid = 'business_transaction'::regclass
              and (select array_agg(a.attname::text order by o.ord) from unnest(con.conkey) with ordinality o(attnum, ord) join pg_attribute a on a.attrelid = con.conrelid and a.attnum = o.attnum) = array['company_id', 'transaction_kind', 'transaction_id']`,
          [k.root],
        );
        if (keyed.rowCount !== 1) missing.push(`${k.root}: no key to its transaction and kind`);
        const unique = await db.query(
          `select 1 from pg_index x where x.indrelid = to_regclass($1) and x.indisunique and x.indpred is null
              and (select array_agg(a.attname::text order by a.attname) from unnest(x.indkey::int2[]) o(attnum) join pg_attribute a on a.attrelid = x.indrelid and a.attnum = o.attnum) <@ array['company_id', 'transaction_id']`,
          [k.root],
        );
        if (unique.rowCount === 0) missing.push(`${k.root}: more than one root could share a transaction`);
      }
      expect(missing).toEqual([]);
    });

    it('a root’s own state check, where it has one, admits exactly the catalogued states', async () => {
      const drift: string[] = [];
      let compared = 0;
      for (const k of kinds) {
        const checks = await db.query<{ conname: string; expr: string }>(
          `select con.conname::text, pg_get_expr(con.conbin, con.conrelid) as expr from pg_constraint con
            where con.conrelid = to_regclass($1) and con.contype = 'c'
              and con.conkey = array[(select a.attnum from pg_attribute a where a.attrelid = con.conrelid and a.attname = 'state')]`,
          [k.root],
        );
        for (const c of checks.rows) {
          compared++;
          for (const s of k.states) {
            const r = await db.query<{ ok: boolean }>(`select (${c.expr}) as ok from (select $1::text as state) x`, [s.state]);
            if (r.rows[0]!.ok !== true) drift.push(`${k.root}.${c.conname} refuses catalogued ${s.state}`);
          }
          const r = await db.query<{ ok: boolean | null }>(`select (${c.expr}) as ok from (select 'NOT_CATALOGUED'::text as state) x`);
          if (r.rows[0]!.ok === true) drift.push(`${k.root}.${c.conname} admits an uncatalogued state`);
        }
      }
      expect(drift).toEqual([]);
      expect(compared).toBeGreaterThan(0);
    });
  });

  describe('every pair of states, on the transaction', () => {
    const GUARD = 'business_transaction_state_guard';

    it('a new transaction starts only in an initial state, and only the guard says so', { timeout: 300_000 }, async () => {
      const failures: string[] = [];
      let refused = 0;
      for (const k of kinds) {
        for (const s of k.states) {
          await db.query('begin');
          try {
            const write = () => db.query(`insert into business_transaction (company_id, kind, state) values ($1, $2, $3)`, [company, k.kind, s.state]);
            if (s.initial) {
              await write();
            } else {
              await db.query('savepoint a');
              await write().then(
                () => failures.push(`${k.kind}: began in non-initial ${s.state}`),
                (e) => {
                  refused++;
                  if (e.code !== CHECK_VIOLATION || !e.message.includes(`state ${s.state} is not an initial state of ${k.kind}`)) failures.push(`${k.kind}/${s.state}: ${e.message}`);
                },
              );
              await db.query('rollback to savepoint a');
              await db.query(`alter table business_transaction disable trigger ${GUARD}`);
              await write();
            }
          } catch (e) {
            failures.push(`${k.kind}/${s.state}: ${(e as Error).message}`);
          } finally {
            await db.query('rollback');
          }
        }
      }
      expect(failures).toEqual([]);
      expect(refused).toBeGreaterThan(100);
    });

    it('each catalogued transition is accepted; every other pair is refused by the guard, and accepted without it', { timeout: 590_000 }, async () => {
      const failures: string[] = [];
      let accepted = 0;
      let refused = 0;
      for (const k of kinds) {
        const allowed = new Set(k.transitions.map((t) => `${t.from}>${t.to}`));
        for (const from of k.states) {
          for (const to of k.states) {
            if (from.state === to.state) continue;
            const label = `${k.kind}: ${from.state} -> ${to.state}`;
            await db.query('begin');
            try {
              const id = await newTransaction(k.kind, from.state);
              const write = () => db.query(`update business_transaction set state = $2 where id = $1`, [id, to.state]);
              if (allowed.has(`${from.state}>${to.state}`)) {
                const r = await write();
                if (r.rowCount !== 1) failures.push(`${label}: not applied`);
                const read = await db.query<{ state: string }>(`select state from business_transaction where id = $1`, [id]);
                if (read.rows[0]!.state !== to.state) failures.push(`${label}: read back ${read.rows[0]!.state}`);
                accepted++;
              } else {
                await db.query('savepoint a');
                await write().then(
                  () => failures.push(`${label}: accepted though not catalogued`),
                  (e) => {
                    refused++;
                    if (e.code !== CHECK_VIOLATION || !e.message.includes(`transition ${from.state} -> ${to.state} is not allowed for ${k.kind}`)) failures.push(`${label}: refused by ${e.message}`);
                  },
                );
                await db.query('rollback to savepoint a');
                await db.query(`alter table business_transaction disable trigger ${GUARD}`);
                const without = await write();
                if (without.rowCount !== 1) failures.push(`${label}: not applied without the guard`);
              }
            } catch (e) {
              failures.push(`${label}: ${(e as Error).message}`);
            } finally {
              await db.query('rollback');
            }
          }
        }
      }
      expect(failures).toEqual([]);
      expect(accepted).toBe(kinds.reduce((n, k) => n + k.transitions.length, 0));
      expect(refused).toBeGreaterThan(500);
    });

    it('an uncatalogued state name and a move out of a terminal state are refused for every kind', { timeout: 300_000 }, async () => {
      const failures: string[] = [];
      for (const k of kinds) {
        const terminal = k.states.find((s) => s.terminal);
        await db.query('begin');
        try {
          const id = await newTransaction(k.kind, k.states.find((s) => s.initial)!.state);
          await db.query(`update business_transaction set state = 'NOT_CATALOGUED' where id = $1`, [id]).then(
            () => failures.push(`${k.kind}: accepted an uncatalogued state`),
            (e) => {
              if (e.code !== CHECK_VIOLATION || !/is not allowed for/.test(e.message)) failures.push(`${k.kind}: ${e.message}`);
            },
          );
        } finally {
          await db.query('rollback');
        }
        if (!terminal) continue;
        for (const to of k.states) {
          if (to.state === terminal.state) continue;
          await db.query('begin');
          try {
            const id = await newTransaction(k.kind, terminal.state);
            await db.query(`update business_transaction set state = $2 where id = $1`, [id, to.state]).then(
              () => failures.push(`${k.kind}: left terminal ${terminal.state} for ${to.state}`),
              (e) => {
                if (e.code !== CHECK_VIOLATION) failures.push(`${k.kind}: ${e.message}`);
              },
            );
          } finally {
            await db.query('rollback');
          }
        }
      }
      expect(failures).toEqual([]);
    });
  });

  describe('the typed root and the transaction (CI12)', () => {
    interface Walkable extends Kind {
      mirror: string;
      ownerColumn: string | null;
    }
    let walkable: Walkable[];
    let stateless: string[];
    let unguarded: string[];
    const AGREES = 'business_transaction_state_agrees';

    beforeAll(async () => {
      const mirrors = await db.query<{ root: string; trigger: string; deferrable: boolean; deferred: boolean }>(`
        select c.relname::text as root, t.tgname::text as trigger, t.tgdeferrable as deferrable, t.tginitdeferred as deferred
          from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid
         where not t.tgisinternal and p.prosrc like '%does not match its transaction state%'`);
      const byRoot = new Map(mirrors.rows.map((m) => [m.root, m]));
      walkable = [];
      stateless = [];
      unguarded = [];
      for (const k of kinds) {
        const shape = shapes.get(k.root) as TableShape;
        if (!shape.columns.some((c) => c.name === 'state')) {
          stateless.push(k.kind);
          continue;
        }
        const mirror = byRoot.get(k.root);
        // Reported by its own test below; the walk carries on over the other kinds, so one missing mirror hides nothing else.
        if (!mirror) {
          unguarded.push(`${k.root} keeps a state and has no mirror trigger`);
          continue;
        }
        if (!mirror.deferrable || !mirror.deferred) {
          unguarded.push(`${k.root}: ${mirror.trigger} is not checked at commit`);
          continue;
        }
        const owner = shape.columns.find((c) => c.name === 'employee_id' || c.name === 'requesting_employee_id');
        walkable.push({ ...k, mirror: mirror.trigger, ownerColumn: owner?.name ?? null });
      }
      // Only the mirror stays. Keys are kept: they are not re-checked for a row whose key does not change.
      for (const k of walkable) {
        const shape = shapes.get(k.root) as TableShape;
        const drop = shape.constraints.filter((c) => c.type === 'c' || c.type === 'x').map((c) => `drop constraint ${quote(c.name)}`);
        await db.query(`alter table ${quote(k.root)} ${[...drop, 'disable trigger user', `enable trigger ${quote(k.mirror)}`].join(', ')}`);
        for (const index of shape.conditionalUniqueIndexes) await db.query(`drop index ${quote(index)}`);
      }
      // The timesheet mirror also compares the current revision's state; its revisions are the one companion a root needs.
      const revisions = shapes.get('timesheet_revision') as TableShape;
      const drop = revisions.constraints.filter((c) => c.type === 'c' || c.type === 'x').map((c) => `drop constraint ${quote(c.name)}`);
      await db.query(`alter table timesheet_revision ${[...drop, 'disable trigger user'].join(', ')}`);
      for (const index of revisions.conditionalUniqueIndexes) await db.query(`drop index ${quote(index)}`);
    });

    /** A committed transaction and root, both in `state`, as the service would leave them. */
    const pair = async (k: Walkable, state: string) => {
      const owner = randomUUID();
      const txn = await newTransaction(k.kind, state, k.ownerColumn ? owner : null);
      const root = randomUUID();
      await asReplica(async () => {
        const row: Record<string, string | null> = { id: root, company_id: company, transaction_id: txn, state };
        const shape = shapes.get(k.root) as TableShape;
        if (shape.columns.some((c) => c.name === 'transaction_kind')) row.transaction_kind = k.kind;
        if (k.ownerColumn) row[k.ownerColumn] = owner;
        if (k.root === 'timesheet') {
          row.current_revision = '1';
          row.approved_revision = null;
        }
        await insertRow(db, shapes, k.root, row);
        if (k.root === 'timesheet') await insertRow(db, shapes, 'timesheet_revision', { company_id: company, timesheet_id: root, revision: '1', state, superseded_at: null });
      });
      return { txn, root };
    };
    const moveTransaction = (txn: string, to: string) => db.query(`update business_transaction set state = $2 where id = $1`, [txn, to]);
    const moveRoot = async (k: Walkable, root: string, to: string) => {
      if (k.root === 'timesheet') await db.query(`update timesheet_revision set state = $2 where timesheet_id = $1 and revision = 1`, [root, to]);
      return db.query(`update ${quote(k.root)} set state = $2 where id = $1`, [root, to]);
    };
    const read = async (k: Walkable, txn: string, root: string) => {
      const r = await db.query<{ t: string; r: string }>(`select bt.state as t, x.state as r from business_transaction bt join ${quote(k.root)} x on x.transaction_id = bt.id where bt.id = $1 and x.id = $2`, [txn, root]);
      return r.rows[0];
    };

    it('every kind with a state has a mirror; the kinds without one are named', () => {
      expect(unguarded).toEqual([]);
      expect(walkable.length).toBeGreaterThanOrEqual(30);
      expect(stateless).toEqual([]);
    });

    it('committed together, in either order, each catalogued transition leaves them equal', { timeout: 590_000 }, async () => {
      const failures: string[] = [];
      let walked = 0;
      for (const k of walkable) {
        for (const t of k.transitions) {
          const label = `${k.kind}: ${t.from} -> ${t.to}`;
          for (const order of ['transaction first', 'root first']) {
            const { txn, root } = await pair(k, t.from);
            await db.query('begin');
            try {
              if (order === 'transaction first') {
                await moveTransaction(txn, t.to);
                await moveRoot(k, root, t.to);
              } else {
                await moveRoot(k, root, t.to);
                await moveTransaction(txn, t.to);
              }
              await db.query('commit');
            } catch (e) {
              await db.query('rollback');
              failures.push(`${label} (${order}): ${(e as Error).message}`);
              continue;
            }
            const after = await read(k, txn, root);
            if (after?.t !== t.to || after?.r !== t.to) failures.push(`${label} (${order}): left ${JSON.stringify(after)}`);
            walked++;
          }
        }
      }
      expect(failures).toEqual([]);
      expect(walked).toBe(walkable.reduce((n, k) => n + k.transitions.length * 2, 0));
    });

    it('rolled back, each transition leaves both where they were', { timeout: 590_000 }, async () => {
      const failures: string[] = [];
      for (const k of walkable) {
        for (const t of k.transitions) {
          const { txn, root } = await pair(k, t.from);
          await db.query('begin');
          try {
            await moveTransaction(txn, t.to);
            await moveRoot(k, root, t.to);
            // Every deferred check runs and passes, then the transaction is thrown away.
            await db.query('set constraints all immediate');
          } catch (e) {
            failures.push(`${k.kind}: ${t.from} -> ${t.to}: ${(e as Error).message}`);
          } finally {
            await db.query('rollback');
          }
          const after = await read(k, txn, root);
          if (after?.t !== t.from || after?.r !== t.from) failures.push(`${k.kind}: ${t.from} -> ${t.to} left ${JSON.stringify(after)}`);
        }
      }
      expect(failures).toEqual([]);
    });

    it('moved on one side only, each transition is refused at commit by the guard of that side, leaving both as they were', { timeout: 590_000 }, async () => {
      const failures: string[] = [];
      let refusedRoot = 0;
      let refusedTransaction = 0;
      for (const k of walkable) {
        for (const t of k.transitions) {
          const label = `${k.kind}: ${t.from} -> ${t.to}`;
          {
            const { txn, root } = await pair(k, t.from);
            await db.query('begin');
            try {
              await moveTransaction(txn, t.to);
              await db.query('commit');
              failures.push(`${label}: transaction moved alone was committed`);
            } catch (e) {
              await db.query('rollback');
              refusedTransaction++;
              const expected = `is in state ${t.to} but its ${k.kind} root is in state ${t.from}`;
              if ((e as { code?: string }).code !== CHECK_VIOLATION || !(e as Error).message.includes(expected)) failures.push(`${label}: transaction alone refused by ${(e as Error).message}`);
            }
            const after = await read(k, txn, root);
            if (after?.t !== t.from || after?.r !== t.from) failures.push(`${label}: transaction alone left ${JSON.stringify(after)}`);
          }
          {
            const { txn, root } = await pair(k, t.from);
            await db.query('begin');
            try {
              await moveRoot(k, root, t.to);
              await db.query('commit');
              failures.push(`${label}: root moved alone was committed`);
            } catch (e) {
              await db.query('rollback');
              refusedRoot++;
              if ((e as { code?: string }).code !== CHECK_VIOLATION || !/does not match its transaction state/.test((e as Error).message)) failures.push(`${label}: root alone refused by ${(e as Error).message}`);
            }
            const after = await read(k, txn, root);
            if (after?.t !== t.from || after?.r !== t.from) failures.push(`${label}: root alone left ${JSON.stringify(after)}`);
          }
        }
      }
      expect(failures).toEqual([]);
      expect(refusedRoot).toBe(refusedTransaction);
      expect(refusedRoot).toBeGreaterThan(150);
    });

    it('without its guard, the same one-sided write passes every remaining check: for each kind, both sides', { timeout: 300_000 }, async () => {
      const failures: string[] = [];
      for (const k of walkable) {
        const t = k.transitions[0]!;
        {
          const { txn } = await pair(k, t.from);
          await db.query('begin');
          try {
            await db.query(`alter table business_transaction disable trigger ${AGREES}`);
            await moveTransaction(txn, t.to);
            await db.query('set constraints all immediate');
          } catch (e) {
            failures.push(`${k.kind}: transaction side still refused: ${(e as Error).message}`);
          } finally {
            await db.query('rollback');
          }
        }
        {
          const { root } = await pair(k, t.from);
          await db.query('begin');
          try {
            await db.query(`alter table ${quote(k.root)} disable trigger ${quote(k.mirror)}`);
            await moveRoot(k, root, t.to);
            await db.query('set constraints all immediate');
          } catch (e) {
            failures.push(`${k.kind}: root side still refused: ${(e as Error).message}`);
          } finally {
            await db.query('rollback');
          }
        }
      }
      expect(failures).toEqual([]);
    });
  });
});
