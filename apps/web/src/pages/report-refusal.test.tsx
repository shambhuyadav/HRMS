// A report whose access ended while a screen was asking about it (F3 row 9; BRD line 4689; ZT05): the screen says so in plain words and
// stops asking, while a passing failure of the server keeps it asking. Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { isReportRefusal } from '../report-failures';
import { ReportExport } from './leave-admin';

vi.mock('../session', () => ({
  useSession: () => ({ stored: { companyId: 'c-1', assignmentId: 'a-1' }, me: { employeeId: null, scopeKind: 'COMPANY' }, can: () => true }),
}));

type Reply = [number, unknown];
function serve(status: () => Reply) {
  const asked: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const [code, body]: Reply = init?.method === 'POST' ? [202, { id: 'r-1', state: 'QUEUED' }] : status();
      if (init?.method !== 'POST') asked.push(url);
      return new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } });
    }),
  );
  return asked;
}
const open = () => {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <ReportExport reportCode="SYNTHETIC" filters={{}} label="Export" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByText('Export'));
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const QUEUED: Reply = [200, { state: 'QUEUED', rowCount: null, failureCode: null }];
const ENDED: Reply = [403, { error: 'FORBIDDEN', message: 'Your access to this report has ended' }];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('a report status refused while it was being polled', () => {
  it('says so in plain words and stops asking', async () => {
    const replies = [QUEUED, ENDED];
    const asked = serve(() => replies.shift() ?? ENDED);
    open();
    expect((await screen.findByRole('alert', {}, { timeout: 6000 })).textContent).toContain('Your access to this report has ended');
    const after = asked.length;
    expect(after).toBe(2);
    await wait(3500);
    expect(asked.length).toBe(after);
  }, 15_000);

  it('a passing failure of the server keeps it asking until the report is ready', async () => {
    const replies: Reply[] = [QUEUED, [503, { error: 'UNAVAILABLE', message: 'Synthetic outage' }], [200, { state: 'COMPLETED', rowCount: 2, failureCode: null }]];
    const asked = serve(() => replies.shift() ?? [200, { state: 'COMPLETED', rowCount: 2, failureCode: null }]);
    open();
    expect(await screen.findByText('Download (2 rows)', {}, { timeout: 9000 })).toBeTruthy();
    expect(asked.length).toBe(3);
  }, 15_000);

  it('only an answer from the application is final', () => {
    expect(isReportRefusal(new ApiError(403, 'FORBIDDEN', 'x'))).toBe(true);
    expect(isReportRefusal(new ApiError(404, 'NOT_FOUND', 'x'))).toBe(true);
    expect(isReportRefusal(new ApiError(503, 'UNAVAILABLE', 'x'))).toBe(false);
    expect(isReportRefusal(new Error('network'))).toBe(false);
    expect(isReportRefusal(null)).toBe(false);
  });
});
