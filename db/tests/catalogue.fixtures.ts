// Helpers (not a test file) for gates that are driven from the PostgreSQL catalogue instead of a hand-kept list, so a table,
// foreign key or transaction kind added later is covered without touching the test (ZT06, ZT10). Synthetic data only.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';

export interface ForeignKey {
  name: string;
  child: string;
  parent: string;
  childColumns: string[];
  parentColumns: string[];
  /** pg_constraint.confdeltype: r restrict, a no action, c cascade, n set null, d set default. */
  onDelete: string;
  validated: boolean;
  childOwned: boolean;
  parentOwned: boolean;
}

export interface Column {
  name: string;
  type: string;
  required: boolean;
  inUniqueKey: boolean;
}

export interface TableShape {
  columns: Column[];
  /** Check, exclusion and foreign key constraints: everything that could refuse a row other than the key under test. */
  constraints: { name: string; type: string }[];
  /** Partial and expression unique indexes, which no foreign key can depend on. */
  conditionalUniqueIndexes: string[];
}

export const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

export async function foreignKeys(db: pg.ClientBase): Promise<ForeignKey[]> {
  const rows = await db.query<{
    name: string;
    child: string;
    parent: string;
    child_columns: string[];
    parent_columns: string[];
    on_delete: string;
    validated: boolean;
    child_owned: boolean;
    parent_owned: boolean;
  }>(`
    select con.conname::text as name, c.relname::text as child, p.relname::text as parent,
           (select array_agg(a.attname::text order by k.ord) from unnest(con.conkey) with ordinality k(attnum, ord)
              join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum) as child_columns,
           (select array_agg(a.attname::text order by k.ord) from unnest(con.confkey) with ordinality k(attnum, ord)
              join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum) as parent_columns,
           con.confdeltype::text as on_delete, con.convalidated as validated,
           exists (select 1 from pg_attribute a where a.attrelid = con.conrelid and a.attname = 'company_id' and not a.attisdropped) as child_owned,
           exists (select 1 from pg_attribute a where a.attrelid = con.confrelid and a.attname = 'company_id' and not a.attisdropped) as parent_owned
      from pg_constraint con
      join pg_class c on c.oid = con.conrelid
      join pg_class p on p.oid = con.confrelid
      join pg_namespace n on n.oid = c.relnamespace
     where con.contype = 'f' and n.nspname = current_schema()
     order by c.relname, con.conname`);
  return rows.rows.map((r) => ({
    name: r.name,
    child: r.child,
    parent: r.parent,
    childColumns: r.child_columns,
    parentColumns: r.parent_columns,
    onDelete: r.on_delete,
    validated: r.validated,
    childOwned: r.child_owned,
    parentOwned: r.parent_owned,
  }));
}

export async function tableShapes(db: pg.ClientBase): Promise<Map<string, TableShape>> {
  const columns = await db.query<{ table_name: string; name: string; type: string; required: boolean; in_unique_key: boolean }>(`
    select c.relname::text as table_name, a.attname::text as name, format_type(a.atttypid, a.atttypmod) as type,
           (a.attnotnull and not a.atthasdef and a.attgenerated = '') as required,
           exists (select 1 from pg_index x where x.indrelid = c.oid and x.indisunique and x.indpred is null and a.attnum = any (x.indkey::smallint[])) as in_unique_key
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = current_schema() and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped and a.attgenerated = '' and a.attidentity = ''
     order by c.relname, a.attnum`);
  const constraints = await db.query<{ table_name: string; name: string; type: string }>(`
    select c.relname::text as table_name, con.conname::text as name, con.contype::text as type
      from pg_constraint con
      join pg_class c on c.oid = con.conrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = current_schema() and con.contype in ('c', 'f', 'x')`);
  const indexes = await db.query<{ table_name: string; name: string }>(`
    select c.relname::text as table_name, i.relname::text as name
      from pg_index x
      join pg_class c on c.oid = x.indrelid
      join pg_class i on i.oid = x.indexrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = current_schema() and x.indisunique and (x.indpred is not null or x.indexprs is not null)`);
  const shapes = new Map<string, TableShape>();
  const shape = (table: string) => {
    let s = shapes.get(table);
    if (!s) {
      s = { columns: [], constraints: [], conditionalUniqueIndexes: [] };
      shapes.set(table, s);
    }
    return s;
  };
  for (const r of columns.rows) shape(r.table_name).columns.push({ name: r.name, type: r.type, required: r.required, inUniqueKey: r.in_unique_key });
  for (const r of constraints.rows) shape(r.table_name).constraints.push({ name: r.name, type: r.type });
  for (const r of indexes.rows) shape(r.table_name).conditionalUniqueIndexes.push(r.name);
  return shapes;
}

let sequence = 0;

/** A fresh value of a column type, as text for a cast parameter. Fresh, so it cannot collide with a unique key. */
export function freshValue(type: string): string {
  const n = ++sequence;
  const base = type.replace(/\(.*\)/, '');
  if (type.endsWith('[]')) return '{}';
  switch (base) {
    case 'uuid':
      return randomUUID();
    case 'text':
      return `V${n}`;
    case 'integer':
    case 'bigint':
      return String(n + 1000);
    case 'smallint':
      return String((n % 30000) + 1);
    case 'numeric':
      return String((n % 9) + 1);
    case 'boolean':
      return 'false';
    case 'date':
      return new Date(Date.UTC(2000, 0, 1) + (n % 20000) * 86_400_000).toISOString().slice(0, 10);
    case 'timestamp with time zone':
      return new Date(Date.UTC(2000, 0, 1) + n * 1000).toISOString();
    case 'time without time zone':
      return `${String(n % 24).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}:00`;
    case 'jsonb':
      return '{}';
    case 'bytea':
      return '\\x00';
    default:
      throw new Error(`No fresh value for column type ${type}: add it here`);
  }
}

/**
 * A row of `table`, as a generated minimum: a value for each required column and for each column of a unique key, then `set`.
 * Only for a table made neutral first (see `neutralise`), since the values satisfy types and nothing else.
 */
export async function insertRow(db: pg.ClientBase, shapes: Map<string, TableShape>, table: string, set: Record<string, string | null>): Promise<void> {
  const shape = shapes.get(table);
  if (!shape) throw new Error(`Unknown table ${table}`);
  const names: string[] = [];
  const casts: string[] = [];
  const values: (string | null)[] = [];
  for (const c of shape.columns) {
    const given = Object.hasOwn(set, c.name);
    if (!given && !c.required && !c.inUniqueKey) continue;
    names.push(quote(c.name));
    values.push(given ? (set[c.name] as string | null) : freshValue(c.type));
    casts.push(`$${values.length}::${c.type}`);
  }
  await db.query(`insert into ${quote(table)} (${names.join(', ')}) values (${casts.join(', ')})`, values);
}

/**
 * Removes everything that could refuse a row of these tables except the one constraint under test: user triggers, checks,
 * exclusions, conditional unique indexes and every other foreign key. Must run inside a transaction that is rolled back, before
 * the transaction writes anything (a table with queued trigger events cannot be altered).
 */
export async function neutralise(db: pg.ClientBase, shapes: Map<string, TableShape>, tables: string[], keep: string | null): Promise<void> {
  for (const table of new Set(tables)) {
    const shape = shapes.get(table);
    if (!shape) throw new Error(`Unknown table ${table}`);
    const parts = shape.constraints.filter((c) => c.name !== keep).map((c) => `drop constraint ${quote(c.name)}`);
    parts.push('disable trigger user');
    await db.query(`alter table ${quote(table)} ${parts.join(', ')}`);
    for (const index of shape.conditionalUniqueIndexes) await db.query(`drop index ${quote(index)}`);
  }
}

export interface OrphanCount {
  constraint: string;
  child: string;
  orphans: number;
  /** Rows with the whole key present, so the foreign key was in force for them. */
  rows: number;
}

/**
 * The referential scan (ZT06): for each foreign key, the child rows with a complete key and no parent row. Foreign keys cannot
 * leave any while they are enforced, so a non-zero count means a write went round them (a disabled trigger, a NOT VALID key,
 * replication mode or a restore). A key with a NULL column is not in force for that row under MATCH SIMPLE and is not counted.
 */
export async function orphanScan(db: pg.ClientBase, fks?: ForeignKey[]): Promise<OrphanCount[]> {
  const counts: OrphanCount[] = [];
  for (const fk of fks ?? (await foreignKeys(db))) {
    const present = fk.childColumns.map((c) => `c.${quote(c)} is not null`).join(' and ');
    const matches = fk.childColumns.map((c, i) => `p.${quote(fk.parentColumns[i] as string)} = c.${quote(c)}`).join(' and ');
    const row = await db.query<{ rows: number; orphans: number }>(
      `select count(*)::int as rows, count(*) filter (where not exists (select 1 from ${quote(fk.parent)} p where ${matches}))::int as orphans
         from ${quote(fk.child)} c where ${present}`,
    );
    counts.push({ constraint: fk.name, child: fk.child, orphans: row.rows[0]!.orphans, rows: row.rows[0]!.rows });
  }
  return counts;
}
