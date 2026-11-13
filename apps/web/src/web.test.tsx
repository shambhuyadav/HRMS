// Web client tests (jsdom): request context headers, sign-out on a 401 for the session in use only (web-6),
// text-bearing status badges (DF10), and dates: calendar dates as given, instants as the local day (web-12).
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, downloadName, formatAmount, formatDate, formatMonth, localDate, pinSession, setSession, setUnauthenticatedHandler } from './api';
import { ErrorNote, StateBadge } from './ui';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSession(null);
  setUnauthenticatedHandler(() => undefined);
});

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('api client (BR-046)', () => {
  it('sends the token and the selected company and assignment on every request', async () => {
    const fetchMock = mockFetch(200, { ok: true });
    setSession({ token: 'tkn', companyId: 'c-1', assignmentId: 'a-1' });
    await api('/v1/employees');
    const headers = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tkn');
    expect(headers['x-hrms-company']).toBe('c-1');
    expect(headers['x-hrms-assignment']).toBe('a-1');
  });

  it('omits the assignment only for role selection', async () => {
    const fetchMock = mockFetch(200, { items: [] });
    setSession({ token: 'tkn', companyId: 'c-1', assignmentId: 'a-1' });
    await api('/v1/me/assignments', { withoutAssignment: true });
    expect((fetchMock.mock.calls[0]![1]!.headers as Record<string, string>)['x-hrms-assignment']).toBeUndefined();
  });

  it('signs out on a 401 for the session in use and surfaces server error codes', async () => {
    mockFetch(401, { error: 'SESSION_IDLE', message: 'The session is no longer valid; sign in again' });
    setSession({ token: 'tkn', companyId: 'c-1', assignmentId: 'a-1' });
    const handler = vi.fn();
    setUnauthenticatedHandler(handler);
    await expect(api('/v1/employees')).rejects.toMatchObject({ status: 401, code: 'SESSION_IDLE' });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('a 401 to a request sent without a token is not a sign-out (web-6)', async () => {
    mockFetch(401, { error: 'UNAUTHENTICATED', message: 'Sign in' });
    const handler = vi.fn();
    setUnauthenticatedHandler(handler);
    await expect(api('/v1/employees')).rejects.toMatchObject({ status: 401 });
    expect(handler).not.toHaveBeenCalled();
  });

  it('a 401 answered for an earlier session’s token does not end the session now in use (web-6)', async () => {
    let answer: (r: Response) => void = () => undefined;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => (answer = resolve))));
    const handler = vi.fn();
    setUnauthenticatedHandler(handler);
    setSession({ token: 'old-token', companyId: 'c-1', assignmentId: 'a-1' });
    const pending = api('/v1/employees');
    setSession({ token: 'new-token', companyId: 'c-1', assignmentId: null });
    answer(new Response(JSON.stringify({ error: 'SESSION_REVOKED', message: 'Signed out' }), { status: 401, headers: { 'content-type': 'application/json' } }));
    await expect(pending).rejects.toMatchObject({ status: 401 });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('actions made of several requests (BR-046)', () => {
  it('send under the session they started in, and nothing once the role, company or user changed', async () => {
    const fetchMock = mockFetch(200, { ok: true });
    setSession({ token: 'tkn', companyId: 'c-1', assignmentId: 'a-1' });
    const send = pinSession();
    await send('/v1/expense/receipts', { body: { fileName: 'r.pdf', contentBase64: 'JVBERi0=' } });
    expect((fetchMock.mock.calls[0]![1]!.headers as Record<string, string>)['x-hrms-assignment']).toBe('a-1');

    setSession({ token: 'tkn', companyId: 'c-1', assignmentId: null }); // Switch role
    await expect(send('/v1/expense/claims', { body: {} })).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
    setSession({ token: 'tkn', companyId: 'c-1', assignmentId: 'a-1' }); // the same role picked again is a new session
    await expect(send('/v1/expense/claims', { body: {} })).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
    setSession(null); // signed out
    await expect(send('/v1/expense/claims', { body: {} })).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('ui', () => {
  it('status badges always carry readable text, not colour alone', () => {
    render(<StateBadge state="MANAGER_PENDING" />);
    expect(screen.getByText('manager pending')).toBeTruthy();
  });

  it('error notes list missing activation requirements', () => {
    render(<ErrorNote error={new ApiError(422, 'ACTIVATION_REQUIREMENTS_MISSING', 'The employee cannot be activated yet', { missing: ['WORK_EMAIL', 'SHIFT_ASSIGNMENT'] })} />);
    expect(screen.getByRole('alert').textContent).toContain('Missing: WORK_EMAIL, SHIFT_ASSIGNMENT');
  });

  it('formats INR amounts with two decimals', () => {
    expect(formatAmount('800.0000')).toBe('INR 800.00');
    expect(formatAmount(null)).toBe('—');
  });
});

describe('dates (web-12)', () => {
  const tz = process.env.TZ;
  afterEach(() => {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  });

  it('keeps calendar dates exactly as given, even west of UTC', () => {
    process.env.TZ = 'America/Los_Angeles';
    expect(formatDate('2026-10-24')).toBe('24 Oct 2026');
    expect(formatDate('2026-03-05')).toBe('5 Mar 2026');
    expect(formatDate(null)).toBe('—');
    expect(formatDate(undefined)).toBe('—');
  });

  it('shows an instant as the browser’s local calendar day', () => {
    process.env.TZ = 'Asia/Tokyo';
    expect(formatDate('2026-10-24T20:00:00Z')).toBe('25 Oct 2026');
    expect(formatDate('2026-10-24T20:00:00.000Z')).toBe('25 Oct 2026');
    process.env.TZ = 'America/Los_Angeles';
    expect(formatDate('2026-10-24T03:00:00Z')).toBe('23 Oct 2026');
  });

  it('shows a month as its short name and year', () => {
    expect(formatMonth('2026-02')).toBe('Feb 2026');
    expect(formatMonth('2026-12')).toBe('Dec 2026');
    expect(formatMonth(null)).toBe('—');
    expect(formatMonth('FY 2026-27')).toBe('FY 2026-27');
  });

  it('gives "today" as the local calendar day, for default date fields', () => {
    process.env.TZ = 'Asia/Kolkata';
    expect(localDate(new Date('2026-10-31T20:00:00Z'))).toBe('2026-11-01');
    process.env.TZ = 'America/Los_Angeles';
    expect(localDate(new Date('2026-11-01T03:00:00Z'))).toBe('2026-10-31');
  });
});

describe('download names (sec-1 follow-up)', () => {
  it('prefers the exact UTF-8 name and falls back to the ASCII one', () => {
    expect(downloadName(`attachment; filename="bill _ March.pdf"; filename*=UTF-8''bill%20%E2%80%94%20March.pdf`)).toBe('bill — March.pdf');
    expect(downloadName('attachment; filename="plain.pdf"')).toBe('plain.pdf');
    expect(downloadName(`attachment; filename="safe.pdf"; filename*=UTF-8''%E0%A4`)).toBe('safe.pdf');
    expect(downloadName(null)).toBe('download.csv');
  });
});
