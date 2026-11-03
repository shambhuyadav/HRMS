import type pg from 'pg';

/** Anything that can run a parameterised query: a pool, a client, or a client inside a transaction. */
export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}
