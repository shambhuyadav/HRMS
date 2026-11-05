// How a tool that is given a database recognises the development one and refuses it (load/fixtures.ts, db/pre-go-live-check.ts).
const DEV_DB_PORT = '54329';
const DEV_DB_NAME = 'hrms_dev';

export function databaseIdentity(url: string): { host: string | null; port: string | null; database: string | null } {
  try {
    const u = new URL(url);
    return { host: u.hostname || null, port: u.port || null, database: decodeURIComponent(u.pathname.replace(/^\//, '')) || null };
  } catch {
    throw new Error('The database URL is not a valid URL');
  }
}

/** Refuses the development database: its fixed port/name, and the DATABASE_URL the development API uses. */
export function assertNotDevelopmentDatabase(url: string, env: Record<string, string | undefined> = process.env): void {
  const target = databaseIdentity(url);
  if (target.port === DEV_DB_PORT || target.database === DEV_DB_NAME) {
    throw new Error(`Refusing the development database (port ${DEV_DB_PORT} / ${DEV_DB_NAME}); use a separate database`);
  }
  const dev = env.DATABASE_URL;
  if (dev) {
    const d = databaseIdentity(dev);
    if (d.host === target.host && (d.port ?? '5432') === (target.port ?? '5432') && d.database === target.database) {
      throw new Error('Refusing DATABASE_URL (the development API database); use a separate database');
    }
  }
}

/** Refuses a database holding the development seed, whatever its name or port. */
export async function assertNoDevelopmentSeed(db: { query(sql: string): Promise<{ rowCount: number | null }> }): Promise<void> {
  if ((await db.query(`select 1 from company where code = 'DEMO'`)).rowCount) {
    throw new Error('The target database holds the development seed (company DEMO); use a separate database');
  }
}
