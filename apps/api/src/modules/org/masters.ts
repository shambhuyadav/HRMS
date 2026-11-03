// Whether an organisation master may be newly used on a date (FR-004, BR-004, DF04; 0102): active, and the date inside its
// period [valid_from, valid_to). Joining, transfer and both employee imports come through here.
import type { Queryable } from '../../db/queryable.js';
import { HttpError } from '../../http/errors.js';

export type MasterTable = 'department' | 'location' | 'designation' | 'grade';

/**
 * Share-locks the master, so a concurrent deactivation or period change (org/routes.ts, under a row lock) is ordered before
 * or after this use. A back-dated joining before the master closed is accepted; one on or after its end is refused.
 */
export async function requireUsableMaster(db: Queryable, table: MasterTable, companyId: string, id: string, onDate: string): Promise<void> {
  const master = (
    await db.query<{ active: boolean; valid_from: string | null; valid_to: string | null }>(`select active, valid_from, valid_to from ${table} where company_id = $1 and id = $2 for share`, [companyId, id])
  ).rows[0];
  if (!master?.active) throw new HttpError(422, 'INVALID_REFERENCE', `${table} is not an active master in this company`);
  if ((master.valid_from !== null && onDate < master.valid_from) || (master.valid_to !== null && onDate >= master.valid_to)) {
    throw new HttpError(422, `${table.toUpperCase()}_OUTSIDE_VALID_PERIOD`, `This ${table} is not valid on ${onDate}`, { validFrom: master.valid_from, validTo: master.valid_to, date: onDate });
  }
}
