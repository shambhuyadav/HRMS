// Small value checks shared by the modules' request validation.

/** A real calendar day written YYYY-MM-DD ("2026-02-30" is refused: it does not round-trip through a date). */
export const isIsoDate = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
