// ZT06 (orphan and tenant mismatch), B1, B3, B4, BRD line 2800: driven from pg_constraint, so a later table or key is covered
// without touching this file. Each key is tried with everything else that could refuse the row removed in a rolled-back
// transaction, and the refusal must name that key, so no key can pass on another guard's refusal. A row that points at a parent
// of the right company is accepted first: the refusals are about the key, not about a row that could never be written.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ForeignKey, foreignKeys, freshValue, insertRow, neutralise, orphanScan, quote, type TableShape, tableShapes } from './catalogue.fixtures.js';
import { FK_VIOLATION, fixtures } from './fixtures.js';
import { startTestDatabase, type TestDatabase } from './test-database.js';

/** BRD line 2800 names company, user_account and permission as roots. The others hold no company data at all. */
const GLOBAL_TABLES: Record<string, string> = {
  company: 'the tenant root (BRD line 2800)',
  user_account: 'a global root (BRD line 2800)',
  permission: 'a global root (BRD line 2800)',
  user_session: 'belongs to a global user_account (DF10)',
  currency: 'ISO 4217 reference shared by every company (0145)',
  schema_migration: 'migration bookkeeping',
  transaction_kind: 'the shared transaction catalogue (0002)',
  transaction_state: 'the shared transaction catalogue (0002)',
  transaction_transition: 'the shared transaction catalogue (0002)',
};

/** A NULL company_id switches a composite key off (MATCH SIMPLE), so company_id is NOT NULL everywhere but here. */
const COMPANY_MAY_BE_NULL: Record<string, string> = {
  scheduled_job_run: 'a job run for no one company (0016); no other table refers to it',
};

/** uuid columns that name no single table, so no foreign key can exist. Anything else ending up here needs a key or a reason. */
const UUID_WITHOUT_FK: Record<string, string> = {
  'audit_event.record_key': 'names a row of any audited table (BRD audit_event)',
  'retention_hold.record_key': 'names a row of any retained table',
  'outbox_event.aggregate_id': 'names the row of any event source',
  'employee_status_history.source_id': 'names the record of whichever source_kind caused the status change',
  'payroll_run.lineage_id': 'groups revisions of one run; it is a group identifier, no row of its own (0140 guards it)',
  'payroll_run_chunk.first_employee_id': 'a keyset boundary of a processing chunk, not a reference',
  'payroll_run_chunk.last_employee_id': 'a keyset boundary of a processing chunk, not a reference',
};

/**
 * A key with two nullable columns is off whenever either is NULL, so the other could hold anything. These are acceptable
 * because of the stated check or key; a new one has to say why the other column cannot hold a foreign row.
 */
const TWO_NULLABLE_COLUMNS: Record<string, string> = {
  attendance_punch_import_row_fk: 'attendance_punch_submission_pair makes them NULL together',
  attendance_record_shift_revision_fkey: 'attendance_record_shift_revision_company_fk (0150) keeps shift_revision_id in the company',
  employee_issued_output_company_id_payroll_record_id_run_id_fkey: 'employee_issued_output_run_period_fk (0150) keeps run_id in the company and on its period',
  payroll_record_component_head_binding: 'head_revision_id has its own composite key; head_type is a code, not a reference',
  payroll_record_input_head_binding: 'head_revision_id has its own composite key; head_type is a code, not a reference',
};

describe('foreign keys, from the catalogue (ZT06; B1, B3, B4)', () => {
  let testDb: TestDatabase;
  let db: pg.Client;
  let fks: ForeignKey[];
  let shapes: Map<string, TableShape>;

  beforeAll(async () => {
    testDb = await startTestDatabase();
    db = testDb.client;
    fks = await foreignKeys(db);
    shapes = await tableShapes(db);
  });

  afterAll(async () => {
    await testDb?.stop();
  });

  const pairs = (fk: ForeignKey) => fk.childColumns.map((c, i) => [c, fk.parentColumns[i] as string] as const);
  const typeOf = (table: string, column: string) => {
    const c = shapes.get(table)?.columns.find((x) => x.name === column);
    if (!c) throw new Error(`No column ${table}.${column}`);
    return c.type;
  };

  describe('what the catalogue holds', () => {
    it('is not an empty reading: the schema has its hundreds of keys', () => {
      expect(fks.length).toBeGreaterThan(1200);
      expect(fks.filter((fk) => fk.childOwned && fk.parentOwned).length).toBeGreaterThan(500);
    });

    it('every key between two company-owned tables pairs company_id with company_id (BRD line 2800)', () => {
      const gaps = fks.filter((fk) => fk.childOwned && fk.parentOwned && !pairs(fk).some(([c, p]) => c === 'company_id' && p === 'company_id')).map((fk) => `${fk.name} (${fk.child} -> ${fk.parent})`);
      expect(gaps).toEqual([]);
    });

    it('no company-owned parent is referred to by a table without a company', () => {
      expect(fks.filter((fk) => fk.parentOwned && !fk.childOwned).map((fk) => fk.name)).toEqual([]);
    });

    it('a key leaving a company-owned table goes only to a named global table', () => {
      const parents = [...new Set(fks.filter((fk) => fk.childOwned && !fk.parentOwned).map((fk) => fk.parent))];
      expect(parents.filter((p) => !Object.hasOwn(GLOBAL_TABLES, p))).toEqual([]);
    });

    it('a table without company_id is one of the named global tables, each still present', () => {
      const global = [...shapes.entries()].filter(([, s]) => !s.columns.some((c) => c.name === 'company_id')).map(([t]) => t).sort();
      expect(global).toEqual(Object.keys(GLOBAL_TABLES).sort());
    });

    it('company_id is NOT NULL in every company-owned table, but for the named exceptions', async () => {
      const rows = await db.query<{ name: string }>(
        `select c.relname::text as name from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = current_schema() and c.relkind = 'r' and a.attname = 'company_id' and not a.attnotnull and not a.attisdropped order by 1`,
      );
      expect(rows.rows.map((r) => r.name)).toEqual(Object.keys(COMPANY_MAY_BE_NULL).sort());
    });

    it('every key is validated, so stored rows were checked too (a NOT VALID key is an open data question)', () => {
      expect(fks.filter((fk) => !fk.validated).map((fk) => fk.name)).toEqual([]);
    });

    it('no key cascades or nulls on delete: a referenced historical parent can only be refused', () => {
      expect(fks.filter((fk) => fk.onDelete !== 'r' && fk.onDelete !== 'a').map((fk) => `${fk.name}:${fk.onDelete}`)).toEqual([]);
    });

    it('every uuid reference column has a key, but for the named columns that name no single table', async () => {
      const rows = await db.query<{ name: string }>(`
        select c.relname || '.' || a.attname as name
          from pg_attribute a
          join pg_class c on c.oid = a.attrelid
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = current_schema() and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
           and a.atttypid = 'uuid'::regtype and a.attname <> 'id'
           and not exists (select 1 from pg_constraint con where con.conrelid = c.oid and con.contype = 'f' and a.attnum = any (con.conkey))
         order by 1`);
      expect(rows.rows.map((r) => r.name)).toEqual(Object.keys(UUID_WITHOUT_FK).sort());
    });

    it('a composite key with two nullable columns cannot be switched off to smuggle a foreign row', async () => {
      const nullable = await db.query<{ conname: string }>(`
        select con.conname::text as conname
          from pg_constraint con
          join pg_class c on c.oid = con.conrelid
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = current_schema() and con.contype = 'f'
           and (select count(*) from unnest(con.conkey) k(attnum)
                  join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
                 where not a.attnotnull and a.attname <> 'company_id') >= 2
         order by 1`);
      expect(nullable.rows.map((r) => r.conname)).toEqual(Object.keys(TWO_NULLABLE_COLUMNS).sort());
    });
  });

  describe('what each key refuses', () => {
    /** Values for the key's parent side: a fresh row's referenced columns, in the given company where the parent has one. */
    const parentKey = (fk: ForeignKey, company: string) => {
      const key: Record<string, string> = {};
      for (const p of fk.parentColumns) key[p] = p === 'company_id' ? company : freshValue(typeOf(fk.parent, p));
      return key;
    };

    const childValues = (fk: ForeignKey, key: Record<string, string>, company: string) => {
      const values: Record<string, string> = {};
      for (const [c, p] of pairs(fk)) values[c] = key[p] as string;
      // The row's own company, whichever company the parent key belongs to: that difference is the mismatch under test.
      if (fk.childOwned && pairs(fk).some(([c, p]) => c === 'company_id' && p === 'company_id')) values.company_id = company;
      else if (fk.childOwned && !fk.childColumns.includes('company_id')) values.company_id = company;
      return values;
    };

    /**
     * One parent row. Where the key refers to its own table, a required referring column points at the row itself (the row must
     * be able to exist), and an optional one stays empty so the row refers to nothing.
     */
    const makeParent = async (fk: ForeignKey, key: Record<string, string>, company: string) => {
      const row: Record<string, string | null> = { ...key };
      const shape = shapes.get(fk.parent) as TableShape;
      if (fk.parentOwned) row.company_id = company;
      if (fk.child === fk.parent) {
        for (const [c, p] of pairs(fk)) {
          if (c === 'company_id' || Object.hasOwn(key, c)) continue;
          row[c] = shape.columns.find((x) => x.name === c)?.required ? (key[p] as string) : null;
        }
      }
      await insertRow(db, shapes, fk.parent, row);
    };

    /** Runs each key's attempts in one transaction that is always rolled back, and returns what did not happen as required. */
    const tryKey = async (fk: ForeignKey, prepare: string | null, attempts: (refused: (what: string, sql: string, params: unknown[]) => Promise<void>) => Promise<void>) => {
      const failures: string[] = [];
      const refused = async (what: string, sql: string, params: unknown[]) => {
        await db.query('savepoint attempt');
        try {
          await db.query(sql, params);
          failures.push(`${fk.name}: ${what} was accepted`);
        } catch (e) {
          const err = e as { code?: string; constraint?: string; message: string };
          if (err.code !== FK_VIOLATION || err.constraint !== fk.name) failures.push(`${fk.name}: ${what} was refused by ${err.code} ${err.constraint ?? err.message}`);
        }
        await db.query('rollback to savepoint attempt');
      };
      await db.query('begin');
      try {
        await db.query('set constraints all immediate');
        await neutralise(db, shapes, [fk.child, fk.parent], fk.name);
        if (prepare) await db.query(prepare);
        await attempts(refused);
      } catch (e) {
        failures.push(`${fk.name}: the attempt itself failed: ${(e as Error).message}`);
      } finally {
        await db.query('rollback');
      }
      return failures;
    };

    const insertSql = (fk: ForeignKey, values: Record<string, string>) => {
      const names = Object.keys(values);
      const shape = shapes.get(fk.child) as TableShape;
      const others = shape.columns.filter((c) => !names.includes(c.name) && (c.required || c.inUniqueKey));
      const all = [...names.map((n) => ({ n, v: values[n] as string, t: typeOf(fk.child, n) })), ...others.map((c) => ({ n: c.name, v: freshValue(c.type), t: c.type }))];
      return {
        sql: `insert into ${quote(fk.child)} (${all.map((x) => quote(x.n)).join(', ')}) values (${all.map((x, i) => `$${i + 1}::${x.t}`).join(', ')})`,
        params: all.map((x) => x.v),
      };
    };

    const exercise = (fk: ForeignKey, prepare: string | null = null) =>
      tryKey(fk, prepare, async (refused) => {
        const companyA = randomUUID();
        const companyB = randomUUID();
        const inA = parentKey(fk, companyA);
        await makeParent(fk, inA, companyA);

        // Missing parent, one key column at a time: a composite key has to bind every column.
        for (const p of fk.parentColumns) {
          if (p === 'company_id') continue;
          const off = { ...inA, [p]: freshValue(typeOf(fk.parent, p)) };
          const ins = insertSql(fk, childValues(fk, off, companyA));
          await refused(`insert with no parent (${p})`, ins.sql, ins.params);
        }

        const sameCompany = fk.childOwned && fk.parentOwned;
        if (sameCompany) {
          const inB = parentKey(fk, companyB);
          await makeParent(fk, inB, companyB);
          const ins = insertSql(fk, childValues(fk, inB, companyA));
          await refused(`insert naming a parent of another company`, ins.sql, ins.params);
        }

        // The control: the same row is accepted against a parent of its own company, so the refusals above are about the key.
        const good = childValues(fk, inA, companyA);
        const ins = insertSql(fk, good);
        await db.query(ins.sql, ins.params);
        const keyColumns = fk.childColumns.map((c, i) => `${quote(c)} = $${i + 1}::${typeOf(fk.child, c)}`).join(' and ');
        const keyParams = fk.childColumns.map((c) => good[c]);
        const offset = fk.childColumns.length;

        // Moving a stored row off its parent, or to another company's.
        for (const [c, p] of pairs(fk)) {
          if (c === 'company_id' && p === 'company_id') continue;
          await refused(`update to no parent (${c})`, `update ${quote(fk.child)} set ${quote(c)} = $${offset + 1}::${typeOf(fk.child, c)} where ${keyColumns}`, [...keyParams, freshValue(typeOf(fk.parent, p))]);
        }
        if (sameCompany) {
          await refused(`update moving the row to another company`, `update ${quote(fk.child)} set company_id = $${offset + 1}::uuid where ${keyColumns}`, [...keyParams, companyB]);
        }

        // Deleting a parent that still has a child.
        const parentWhere = fk.parentColumns.map((p, i) => `${quote(p)} = $${i + 1}::${typeOf(fk.parent, p)}`).join(' and ');
        await refused(`delete of a referenced parent`, `delete from ${quote(fk.parent)} where ${parentWhere}`, fk.parentColumns.map((p) => inA[p]));
      });

    it('between company-owned tables: a missing parent, another company, a moved row and a deleted parent are each refused by that key', { timeout: 590_000 }, async () => {
      const keys = fks.filter((fk) => fk.childOwned && fk.parentOwned);
      const failures: string[] = [];
      for (const fk of keys) failures.push(...(await exercise(fk)));
      expect(failures).toEqual([]);
      expect(keys.length).toBeGreaterThan(500);
    });

    it('to a global table: a missing parent, a moved row and a deleted parent are each refused by that key', { timeout: 590_000 }, async () => {
      const keys = fks.filter((fk) => !(fk.childOwned && fk.parentOwned));
      const failures: string[] = [];
      for (const fk of keys) failures.push(...(await exercise(fk)));
      expect(failures).toEqual([]);
      expect(keys.length).toBeGreaterThan(700);
    });

    it('the exercise does notice: the same attempts against a key that binds only the id report the tenant gap', async () => {
      // Sensitivity of the method itself: the department key of an assignment is replaced by the single-column key BRD line 2800 forbids.
      const real = fks.find((x) => x.child === 'employment_assignment' && x.parent === 'department' && x.childColumns.length === 2);
      if (!real) throw new Error('no department key on employment_assignment');
      const weak: ForeignKey = { ...real, name: 'weak_key', childColumns: ['department_id'], parentColumns: ['id'] };
      const failures = await exercise(weak, `alter table employment_assignment add constraint weak_key foreign key (department_id) references department (id)`);
      expect(failures).toEqual(['weak_key: insert naming a parent of another company was accepted', 'weak_key: update moving the row to another company was accepted']);
    });

    it('the three loose references of 0150 are held to the company even with the other key column empty', async () => {
      const f = fixtures(db);
      const a = await f.makeCompany();
      const b = await f.makeCompany();
      // Everything but the key under test is removed, and the second column of the composite key is left NULL.
      const halfEmpty = async (fk: string, child: string, parent: string, column: string, empty: string[]) => {
        await db.query('begin');
        try {
          await db.query('set constraints all immediate');
          await neutralise(db, shapes, [child, parent], fk);
          const foreign = randomUUID();
          await insertRow(db, shapes, parent, { id: foreign, company_id: b.company });
          const row = { company_id: a.company, [column]: foreign, ...Object.fromEntries(empty.map((c) => [c, null])) };
          await expect(insertRow(db, shapes, child, row)).rejects.toMatchObject({ code: FK_VIOLATION, constraint: fk });
        } finally {
          await db.query('rollback');
        }
      };
      await halfEmpty('leave_request_revision_policy_company_fk', 'leave_request_revision', 'leave_policy', 'policy_id', []);
      await halfEmpty('attendance_record_shift_revision_company_fk', 'attendance_record', 'shift_revision', 'shift_revision_id', ['shift_id']);
    });
  });

  describe('the referential scan (ZT06)', () => {
    it('finds a planted orphan and a planted company mismatch, and nothing once they are gone', { timeout: 300_000 }, async () => {
      const f = fixtures(db);
      const a = await f.makeCompany();
      const b = await f.makeCompany();
      const e1 = await f.makeEmployee(a, 'SCAN1');
      const mismatch = randomUUID();
      const orphan = randomUUID();
      const scan = async () => (await orphanScan(db)).filter((r) => r.orphans > 0);
      expect(await scan()).toEqual([]);

      // Written in replication mode, the one way past a key; the department exists, but in the other company.
      await db.query('set session_replication_role = replica');
      try {
        await db.query(`insert into employment_assignment (id, company_id, employee_id, department_id, location_id, designation_id, effective_from, effective_to) values ($1, $2, $3, $4, $5, $6, '2026-01-05', '2026-02-01')`, [mismatch, a.company, e1, b.dept, a.loc, a.desig]);
        await db.query(`insert into employment_assignment (id, company_id, employee_id, department_id, location_id, designation_id, effective_from) values ($1, $2, $3, $4, $5, $6, '2026-03-01')`, [orphan, a.company, e1, randomUUID(), a.loc, a.desig]);
      } finally {
        await db.query('set session_replication_role = origin');
      }
      const found = await scan();
      expect(found.map((r) => r.constraint)).toEqual(expect.arrayContaining([expect.stringMatching(/department/)]));
      expect(found.find((r) => /department/.test(r.constraint))?.orphans).toBe(2);

      await db.query('set session_replication_role = replica');
      try {
        await db.query(`delete from employment_assignment where id = any ($1::uuid[])`, [[mismatch, orphan]]);
      } finally {
        await db.query('set session_replication_role = origin');
      }
      expect(await scan()).toEqual([]);
    });
  });
});
