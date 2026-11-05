// The schema constraint register (docs/07 template; B7, B8; "QA maps constraints to ZT06 to ZT12", BRD line 4812). Read from the catalogue
// of a migrated database, so it can only describe what the database really enforces. One row per column.
import type pg from 'pg';

export interface ColumnRow {
  table: string;
  column: string;
  pk: string;
  fk: string;
  unique: string;
  nullability: string;
  refCategory: string;
  intervalRule: string;
  companyBoundary: string;
  ciZt: string;
  mechanism: string;
}

export interface TableTrigger {
  table: string;
  trigger: string;
  when: string;
  fn: string;
}

export interface SchemaRegister {
  columns: ColumnRow[];
  triggers: TableTrigger[];
  tableCount: number;
  unvalidated: { table: string; constraint: string }[];
}

interface ColumnInfo {
  table_name: string;
  name: string;
  type: string;
  not_null: boolean;
  default_expression: string | null;
}

interface ConstraintInfo {
  table_name: string;
  name: string;
  kind: string;
  columns: string[];
  definition: string;
  parent: string | null;
  parent_columns: string[] | null;
  validated: boolean;
  deferrable: boolean;
}

/** Names from the docs/07 enforcement record: a constraint or trigger it names, or a `*_suffix` pattern, gives that CI. */
export type CiNames = readonly { ci: string; name: string }[];

export function parseEnforcementRecord(docs07: string): CiNames {
  const names: { ci: string; name: string }[] = [];
  for (const line of docs07.split(/\r?\n/)) {
    const row = /^\| (CI\d{2}) \|/.exec(line);
    if (!row) continue;
    for (const m of line.matchAll(/`([a-z_*][a-z0-9_*]*)`/g)) names.push({ ci: row[1]!, name: m[1]! });
  }
  return names;
}

const matchesName = (pattern: string, name: string) =>
  pattern.includes('*') ? new RegExp(`^${pattern.replace(/\*/g, '.*')}$`).test(name) : pattern === name;

const IMMUTABLE_FUNCTIONS = new Set(['hrms_columns_fixed', 'hrms_columns_set_once']);
const DATE_TYPE = /^(date|timestamp)/;

export async function buildSchemaRegister(db: pg.ClientBase, ciNames: CiNames = []): Promise<SchemaRegister> {
  const columns = (
    await db.query<ColumnInfo>(`
      select c.relname::text as table_name, a.attname::text as name, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as not_null,
             pg_get_expr(d.adbin, d.adrelid) as default_expression
        from pg_attribute a
        join pg_class c on c.oid = a.attrelid
        join pg_namespace n on n.oid = c.relnamespace
        left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
       where n.nspname = current_schema() and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped and c.relname <> 'schema_migration'
       order by c.relname, a.attnum`)
  ).rows;

  const constraints = (
    await db.query<ConstraintInfo>(`
      select c.relname::text as table_name, con.conname::text as name, con.contype::text as kind,
             coalesce((select array_agg(a.attname::text order by k.ord) from unnest(con.conkey) with ordinality k(attnum, ord)
                         join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum), '{}') as columns,
             pg_get_constraintdef(con.oid) as definition,
             p.relname::text as parent,
             (select array_agg(a.attname::text order by k.ord) from unnest(con.confkey) with ordinality k(attnum, ord)
                join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum) as parent_columns,
             con.convalidated as validated, con.condeferrable as deferrable
        from pg_constraint con
        join pg_class c on c.oid = con.conrelid
        join pg_namespace n on n.oid = c.relnamespace
        left join pg_class p on p.oid = con.confrelid
       where n.nspname = current_schema() and con.contype in ('p', 'f', 'u', 'c', 'x')
       order by c.relname, con.conname`)
  ).rows;

  const uniqueIndexes = (
    await db.query<{ table_name: string; name: string; columns: string[]; definition: string }>(`
      select c.relname::text as table_name, i.relname::text as name,
             coalesce((select array_agg(a.attname::text) from unnest(x.indkey::smallint[]) k(attnum) join pg_attribute a on a.attrelid = x.indrelid and a.attnum = k.attnum where k.attnum > 0), '{}') as columns,
             pg_get_indexdef(x.indexrelid) as definition
        from pg_index x
        join pg_class c on c.oid = x.indrelid
        join pg_class i on i.oid = x.indexrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = current_schema() and x.indisunique and not x.indisprimary
         and not exists (select 1 from pg_constraint con where con.conindid = x.indexrelid)
       order by c.relname, i.relname`)
  ).rows;

  const triggerRows = (
    await db.query<{ table_name: string; name: string; fn: string; args: string[]; update_of: string[]; timing: number; deferred: boolean }>(`
      select c.relname::text as table_name, t.tgname::text as name, p.proname::text as fn,
             array_remove(string_to_array(encode(t.tgargs, 'escape'), E'\\\\000'), '') as args,
             coalesce((select array_agg(a.attname::text) from unnest(t.tgattr::smallint[]) k(attnum) join pg_attribute a on a.attrelid = t.tgrelid and a.attnum = k.attnum), '{}') as update_of,
             t.tgtype::int as timing, t.tgdeferrable as deferred
        from pg_trigger t
        join pg_class c on c.oid = t.tgrelid
        join pg_namespace n on n.oid = c.relnamespace
        join pg_proc p on p.oid = t.tgfoid
       where n.nspname = current_schema() and not t.tgisinternal
       order by c.relname, t.tgname`)
  ).rows;

  const hasCompany = new Set(columns.filter((c) => c.name === 'company_id').map((c) => c.table_name));
  const columnsOf = new Map<string, ColumnInfo[]>();
  for (const c of columns) columnsOf.set(c.table_name, [...(columnsOf.get(c.table_name) ?? []), c]);
  const constraintsOf = new Map<string, ConstraintInfo[]>();
  for (const c of constraints) constraintsOf.set(c.table_name, [...(constraintsOf.get(c.table_name) ?? []), c]);

  const ciFor = (name: string) => ciNames.filter((n) => matchesName(n.name, name)).map((n) => n.ci);
  const literal = (expression: string | null | undefined) => /^'([^']+)'/.exec(expression ?? '')?.[1];

  const rows: ColumnRow[] = columns.map((col) => {
    const own = constraintsOf.get(col.table_name) ?? [];
    const uses = (c: ConstraintInfo) => c.columns.includes(col.name) || (c.kind === 'x' && new RegExp(`\\b${col.name}\\b`).test(c.definition));
    const pick = (kind: string) => own.filter((c) => c.kind === kind && uses(c));
    const [pks, fks, uniques, checks, exclusions] = [pick('p'), pick('f'), pick('u'), pick('c'), pick('x')];
    const indexes = uniqueIndexes.filter((i) => i.table_name === col.table_name && (i.columns.includes(col.name) || new RegExp(`\\b${col.name}\\b`).test(i.definition)));
    const triggers = triggerRows.filter((t) => t.table_name === col.table_name);
    const fixedBy = triggers.filter((t) => IMMUTABLE_FUNCTIONS.has(t.fn) && t.args.includes(col.name));
    const firesOn = triggers.filter((t) => !IMMUTABLE_FUNCTIONS.has(t.fn) && t.update_of.includes(col.name));

    // The category a reference-value key fixes (its child column for reference_value.category holds a one-value default); else a CHECK list.
    const referenceKey = fks.find((f) => f.parent === 'reference_value' && f.parent_columns?.includes('category'));
    const categoryColumn = referenceKey?.columns[referenceKey.parent_columns!.indexOf('category')];
    const category = literal((columnsOf.get(col.table_name) ?? []).find((c) => c.name === categoryColumn)?.default_expression);
    const fixedList = checks.find((c) => c.columns.length === 1 && /= ANY \(|IN \(/.test(c.definition));
    const refCategory = referenceKey ? category ?? categoryColumn ?? 'reference_value' : fixedList ? `Fixed list (${fixedList.name})` : '';

    const orderingChecks = DATE_TYPE.test(col.type) ? checks.filter((c) => c.columns.length >= 2 && /[<>]/.test(c.definition) && c.columns.filter((n) => DATE_TYPE.test((columnsOf.get(col.table_name) ?? []).find((x) => x.name === n)?.type ?? '')).length >= 2) : [];
    const intervalRule = [...exclusions.map((c) => c.name), ...orderingChecks.map((c) => c.name)].join(', ');

    const bound = fks.filter((f) => f.columns.includes('company_id'));
    const toCompanyOwned = fks.filter((f) => !f.columns.includes('company_id') && f.parent !== null && hasCompany.has(f.parent));
    const companyBoundary = !hasCompany.has(col.table_name)
      ? 'Global table'
      : col.name === 'company_id'
        ? 'Owner column'
        : toCompanyOwned.length
          ? `NOT held to the row's company: ${toCompanyOwned.map((f) => f.name).join(', ')}`
          : bound.length
            ? 'Composite key with company_id'
            : fks.length
              ? 'Parent is a global table'
              : '';

    // By kind of rule, from the wording of ZT06 to ZT12 (BRD lines 4773-4779). CI only where the docs/07 record names the mechanism.
    const gates = new Set<string>();
    if (fks.length) gates.add('ZT06');
    if (pks.length || uniques.length || indexes.length) gates.add('ZT07');
    if (col.not_null || checks.length || referenceKey) gates.add('ZT08');
    if (intervalRule) gates.add('ZT09');
    if (col.name === 'state') gates.add('ZT10');
    if (col.name === 'version') gates.add('ZT11');
    if (fixedBy.length) gates.add('ZT12');
    const named = [...pks, ...fks, ...uniques, ...checks, ...exclusions].map((c) => c.name).concat(indexes.map((i) => i.name), fixedBy.map((t) => t.name), firesOn.map((t) => t.name));
    const cis = [...new Set(named.flatMap(ciFor))].sort();

    const mechanism = [
      pks.map((c) => `PK ${c.name}`),
      fks.map((c) => `FK ${c.name}${c.validated ? '' : ' (NOT VALID)'}${c.deferrable ? ' (at commit)' : ''}`),
      uniques.map((c) => `UQ ${c.name}`),
      indexes.map((i) => `UQ index ${i.name}`),
      col.not_null ? ['NOT NULL'] : [],
      checks.map((c) => `CK ${c.name}${c.validated ? '' : ' (NOT VALID)'}`),
      exclusions.map((c) => `EX ${c.name}`),
      fixedBy.map((t) => `TR ${t.name}`),
      firesOn.map((t) => `TR ${t.name}`),
    ].flat().join('; ');

    return {
      table: col.table_name,
      column: col.name,
      pk: pks.length ? 'Yes' : '',
      fk: fks.map((f) => `${f.parent}(${f.parent_columns?.join(', ')})`).join('; '),
      unique: [...uniques.map((c) => c.name), ...indexes.map((i) => i.name)].join(', '),
      nullability: `${col.not_null ? 'NOT NULL' : 'NULL'}${col.default_expression ? ' with default' : ''}`,
      refCategory,
      intervalRule,
      companyBoundary,
      ciZt: [...cis, ...[...gates].sort()].join(', '),
      mechanism,
    };
  });

  const describeTiming = (t: { timing: number; deferred: boolean; update_of: string[] }) => {
    // pg_trigger.tgtype bits: 1 row, 2 before, 4 insert, 8 delete, 16 update, 32 truncate.
    const events = [t.timing & 4 && 'insert', t.timing & 16 && (t.update_of.length ? `update of ${t.update_of.join(', ')}` : 'update'), t.timing & 8 && 'delete', t.timing & 32 && 'truncate'].filter(Boolean).join(', ');
    return `${t.deferred ? 'at commit' : t.timing & 2 ? 'before' : 'after'} ${events}${t.timing & 1 ? '' : ' (statement)'}`;
  };

  return {
    columns: rows,
    triggers: triggerRows.map((t) => ({ table: t.table_name, trigger: t.name, when: describeTiming(t), fn: t.args.length ? `${t.fn}(${t.args.join(', ')})` : t.fn })),
    tableCount: columnsOf.size,
    unvalidated: constraints.filter((c) => !c.validated).map((c) => ({ table: c.table_name, constraint: c.name })),
  };
}
