// Per-company fairness for a worker queue's claims (docs/09 §7.2; G3 "Apply per-company fairness"). A queue claims in company
// order from a cursor, one item per company, wrapping around at the end: with K companies holding work, each is reached within K
// claims however large another's backlog is. Within a company a queue keeps its own order. The cursor is only a position, kept
// per process and starting at a random place so workers do not walk in step; losing it (a restart) loses nothing, and the claim's
// `for update skip locked` is what keeps workers off each other's items.
import { randomUUID } from 'node:crypto';

/** Sorts before every company: the cursor that starts a walk from the first company. */
export const FIRST_COMPANY = '00000000-0000-0000-0000-000000000000';

export interface CompanyTurns {
  /**
   * Claims the next item after the cursor (`company_id > after`, in company order), wrapping around once when nothing lies beyond
   * it. Answers null when no company has anything to claim. `companyId` says whose turn was taken.
   */
  next<T extends { companyId: string }>(claim: (after: string) => Promise<T | null>): Promise<T | null>;
}

export function companyTurns(): CompanyTurns {
  let cursor: string = randomUUID();
  return {
    async next(claim) {
      const claimed = (await claim(cursor)) ?? (cursor === FIRST_COMPANY ? null : await claim(FIRST_COMPANY));
      cursor = claimed ? claimed.companyId : FIRST_COMPANY;
      return claimed;
    },
  };
}
