// Applies db/migrations/*.sql in filename order, each in its own transaction.
// Applied files are checksummed; editing an applied migration is refused (write a new one instead).
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * A migration being written is saved as NNNN_name.draft.sql and applied only when its file name is listed in
 * HRMS_DRAFT_MIGRATIONS (comma-separated, never in production), so a half-written file cannot break the test
 * runs of anyone else sharing the tree. Rename it to .sql once its tests pass.
 */
function includedDrafts(): Set<string> {
  const listed = (process.env.HRMS_DRAFT_MIGRATIONS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (listed.length > 0 && process.env.NODE_ENV === 'production') throw new Error('Draft migrations cannot be applied in production');
  return new Set(listed);
}

export interface MigrateOptions {
  /**
   * Applies only the files whose names sort before this one (for example '0071'), so an upgrade test can build the
   * schema a migration starts from, add rows, then run `migrate` again for the rest.
   */
  before?: string;
}

export async function migrate(client: pg.Client, options: MigrateOptions = {}): Promise<string[]> {
  await client.query(`
    create table if not exists schema_migration (
      filename   text primary key,
      checksum   text not null,
      applied_at timestamptz not null default now()
    )`);

  const applied = new Map<string, string>(
    (await client.query<{ filename: string; checksum: string }>('select filename, checksum from schema_migration'))
      .rows.map((r) => [r.filename, r.checksum]),
  );

  const drafts = includedDrafts();
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql') && (!f.endsWith('.draft.sql') || drafts.has(f)))
    .filter((f) => options.before === undefined || f < options.before)
    .sort();
  const newlyApplied: string[] = [];

  for (const file of files) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const previous = applied.get(file);
    if (previous !== undefined) {
      if (previous !== checksum) throw new Error(`Applied migration ${file} has been modified`);
      continue;
    }
    await client.query('begin');
    try {
      await client.query(sql);
      await client.query('insert into schema_migration (filename, checksum) values ($1, $2)', [file, checksum]);
      await client.query('commit');
      newlyApplied.push(file);
    } catch (err) {
      await client.query('rollback');
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    }
  }
  return newlyApplied;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set (see .env.example)');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const done = await migrate(client);
    console.log(done.length ? `Applied: ${done.join(', ')}` : 'Database is up to date');
  } finally {
    await client.end();
  }
}
