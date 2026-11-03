// Retrying worker steps (ADR-13 cadence), shared by bulk jobs and report generation.
import { HttpError } from '../../http/errors.js';

/** A failing step is retried after 1, 5 and 15 minutes; the next failure ends it FAILED. */
export const RETRY_MINUTES: readonly number[] = [1, 5, 15];

/**
 * A failure of one unit of a bulk chunk, thrown by a kind that lists its failing unit (FR-022 attendance processing):
 * `failure` is what went wrong, `unit` the id of the unit it went wrong on. The chunk still rolls back whole.
 */
export class UnitFailure extends Error {
  constructor(
    readonly failure: unknown,
    readonly unit: string,
  ) {
    super('A unit of the chunk failed');
    this.name = 'UnitFailure';
  }
}

/** An error class for the record: an HTTP rule code, a PostgreSQL code or the error's name; never its message (it may hold values). */
export function failureCode(err: unknown): string {
  if (err instanceof UnitFailure) return failureCode(err.failure);
  if (err instanceof HttpError && /^[A-Z][A-Z0-9_]{0,59}$/.test(err.code)) return err.code;
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Z0-9]{5}$/.test(code)) return `PG_${code}`;
  const name = err instanceof Error ? err.name : 'Error';
  return /^[A-Za-z0-9_.:-]{1,100}$/.test(name) ? name : 'Error';
}
