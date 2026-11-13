// API client. Every request carries the bearer token and the explicitly selected company and role
// assignment (BR-046). The server authorises every call; the client only hides what it cannot use.

export interface SessionState {
  token: string;
  companyId: string | null;
  assignmentId: string | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

let current: SessionState | null = null;
let onUnauthenticated: () => void = () => undefined;

export function setSession(s: SessionState | null) {
  current = s;
}
export function setUnauthenticatedHandler(handler: () => void) {
  onUnauthenticated = handler;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT';
  body?: unknown;
  /** Only for role selection: the assignment header may be absent. */
  withoutAssignment?: boolean;
}

function headers(opts: RequestOptions): Record<string, string> {
  const h: Record<string, string> = { accept: 'application/json' };
  if (opts.body !== undefined) h['content-type'] = 'application/json';
  if (current?.token) h.authorization = `Bearer ${current.token}`;
  if (current?.companyId) h['x-hrms-company'] = current.companyId;
  if (current?.assignmentId && !opts.withoutAssignment) h['x-hrms-assignment'] = current.assignmentId;
  return h;
}

/**
 * `sentToken` is the token the failed request carried. Only a 401 for the session still in use ends it: a request
 * sent without a token, or with an earlier session's token (answered after a sign-out or a new sign-in), says
 * nothing about the current session.
 */
async function raise(res: Response, sentToken: string | undefined): Promise<never> {
  let body: { error?: string; message?: string; details?: unknown } = {};
  try {
    body = await res.json();
  } catch {
    /* non-JSON error */
  }
  if (res.status === 401 && sentToken !== undefined && sentToken === current?.token) onUnauthenticated();
  throw new ApiError(res.status, body.error ?? 'ERROR', body.message ?? res.statusText, body.details);
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const sentToken = current?.token;
  const res = await fetch(path, {
    method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
    headers: headers(opts),
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  if (!res.ok) return raise(res, sentToken);
  return (await res.json()) as T;
}

export interface PinnedRequest {
  <T>(path: string, opts?: RequestOptions): Promise<T>;
  /** Whether the session it was bound to is still the one in use, for an answer that arrives after a change. */
  isCurrent(): boolean;
}

/**
 * For an action made of several requests (e.g. receipt uploads, then the claim, then its submission): a request
 * function bound to the session in use now. Once the user signs out or picks another company or role, the rest of
 * the action is not sent, so nothing started under one role is finished under another (BR-046).
 */
export function pinSession(): PinnedRequest {
  const started = current;
  const isCurrent = () => current === started;
  const send = <T,>(path: string, opts: RequestOptions = {}) =>
    isCurrent() ? api<T>(path, opts) : Promise.reject<T>(new ApiError(0, 'SESSION_CHANGED', 'The role or company changed before this was finished; nothing more was sent'));
  return Object.assign(send, { isCurrent });
}

/**
 * The file name from a Content-Disposition header: the exact UTF-8 name (filename*, RFC 5987) when present, else the
 * ASCII fallback (filename="...").
 */
export function downloadName(disposition: string | null, fallback = 'download.csv'): string {
  const extended = /filename\*=UTF-8''([^;]+)/i.exec(disposition ?? '')?.[1];
  if (extended) {
    try {
      return decodeURIComponent(extended.trim());
    } catch {
      /* malformed encoding: use the quoted fallback */
    }
  }
  return /filename="([^"]+)"/.exec(disposition ?? '')?.[1] ?? fallback;
}

/** Downloads a protected file (the server re-checks access) and hands it to the browser. */
export async function download(path: string): Promise<void> {
  const sentToken = current?.token;
  const res = await fetch(path, { headers: headers({}) });
  if (!res.ok) return raise(res, sentToken);
  const name = downloadName(res.headers.get('content-disposition'));
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Reads a chosen file as base64 for JSON upload bodies. */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read'));
    reader.readAsDataURL(file);
  });
}

/** A fresh idempotency key per user action (decisions, payments) so retries never double-apply. */
export function idempotencyKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** The browser's local calendar day (YYYY-MM-DD) of an instant, by default now: "today" for date fields. */
export function localDate(at: Date = new Date()): string {
  return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`;
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** A calendar day (YYYY-MM-DD) as people read it: "3 Nov 2026"; anything else unchanged. */
export function dayText(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  const month = m ? MONTHS_SHORT[Number(m[2]) - 1] : undefined;
  return m && month ? `${Number(m[3])} ${month} ${m[1]}` : day;
}

/** A month (YYYY-MM, e.g. a payroll month) as people read it: "Feb 2026"; anything else unchanged. */
export function formatMonth(month: string | null | undefined): string {
  if (!month) return '—';
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  const name = m ? MONTHS_SHORT[Number(m[2]) - 1] : undefined;
  return m && name ? `${name} ${m[1]}` : month;
}

/**
 * A calendar date (YYYY-MM-DD, e.g. a leave or expiry date) is shown as that day ("3 Nov 2026"), never shifted by the time zone.
 * An instant (an ISO timestamp such as an upload or assignment time) is shown as the browser's local calendar day, not the UTC one.
 */
export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return dayText(value);
  const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) ? new Date(value) : null;
  if (!instant || Number.isNaN(instant.getTime())) return dayText(value.slice(0, 10));
  return dayText(localDate(instant));
}
/** A quantity such as days as a person reads it: padding zeros gone, nothing rounded ("12.0000" reads 12, "1.6667" stays). */
export const formatUnits = (value: string | number | null | undefined) => {
  if (value === null || value === undefined) return '—';
  const text = String(value);
  return /^-?\d+\.\d+$/.test(text) ? text.replace(/\.?0+$/, '') : text;
};
export const formatAmount = (value: string | null | undefined, currency = 'INR') =>
  value === null || value === undefined ? '—' : `${currency} ${Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
