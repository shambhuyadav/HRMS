// Why a report was not generated, in plain words (FR-056 "human-readable no-data/error states"). The server gives a code:
// a rule of its own, or an error class such as PG_57014 that means nothing to the requester, so an unnamed code is said
// in general words and quoted for support.
const REPORT_FAILURES: Record<string, string> = {
  ACCESS_REVOKED: 'Your access changed after the request, so nothing was generated.',
  REPORT_UNAVAILABLE: 'This report is no longer available, so nothing was generated.',
  SCOPE_INCOMPLETE: 'Some records of this payroll run are outside your access, so these company figures were not generated.',
  WORKER_INTERRUPTED: 'Generation kept being interrupted, so it stopped. Request the report again.',
};

export function reportFailureText(code: string): string {
  return REPORT_FAILURES[code] ?? `The report could not be generated. Request it again; if it keeps failing, quote ${code} to support.`;
}

/** What a report's state and failure code say to its requester; null when they need no words. */
export function reportProblem(r: { state?: string | undefined; failureCode?: string | null | undefined }): string | null {
  if (!r.failureCode) return null;
  if (r.state === 'FAILED') return reportFailureText(r.failureCode);
  return r.state === 'QUEUED' || r.state === 'RUNNING' ? 'The last attempt failed; it is being tried again.' : null;
}
