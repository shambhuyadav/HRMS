// How often an import screen re-checks a batch waiting for the malware scan (pages/records.tsx useHeldBatchWatch). Starting values,
// not measured (G4): each check is one POST .../:id/resume per open screen, so a change here changes the load on the API.

/** The wait between automatic checks of one held batch. */
export const HELD_BATCH_CHECK_INTERVAL_MS = 10_000;

/** Automatic checks before the screen stops and leaves the manual check: about five minutes at the interval above. */
export const HELD_BATCH_MAX_CHECKS = 30;
