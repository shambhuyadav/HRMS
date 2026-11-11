// Send mail (jsdom; BRD coverage CL-041 "Send Mail"; FR-085; DF12 email only once configured; BR-026; BR-044; migration 0282): with email
// off the screen says so plainly and offers no send; recipients are reviewed before anything is sent, and only the reviewed eligible ones
// are sent to; refusals read in words. Synthetic data only (example.invalid addresses).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SEND_MAIL_PERMISSION, SEND_MAIL_SCREENS } from './send-mail';

vi.mock('../session', () => ({
  useSession: () => ({ stored: { companyId: 'c-1', assignmentId: 'a-1' }, me: { employeeId: null, scopeKind: 'COMPANY' }, can: () => true }),
}));

const E1 = '20000000-0000-4000-8000-000000000001';
const E2 = '20000000-0000-4000-8000-000000000002';
const E3 = '20000000-0000-4000-8000-000000000003';
const LIMITS = { recipients: 500, subject: 150, message: 5000, listRows: 2000 };
const ON = { email: 'ON', attachments: false, limits: LIMITS };
const OFF = { email: 'OFF', reason: 'EMAIL_NOT_CONFIGURED', attachments: false, limits: LIMITS };
const CHART = {
  asOf: '2026-11-11',
  truncated: false,
  items: [
    { id: E1, code: 'SYN-001', name: 'Synthetic Asha', designation: 'Engineer', department: 'Engineering', location: 'HQ', managerId: null },
    { id: E2, code: 'SYN-002', name: 'Synthetic Ravi', designation: 'Engineer', department: 'Engineering', location: 'HQ', managerId: null },
    { id: E3, code: 'SYN-003', name: 'Synthetic Meera', designation: 'Analyst', department: 'Finance', location: 'HQ', managerId: null },
  ],
};
const REVIEW = {
  recipients: [
    { employeeId: E1, employeeCode: 'SYN-001', displayName: 'Synthetic Asha', workEmail: 'asha@example.invalid', outcome: 'ELIGIBLE' },
    { employeeId: E2, employeeCode: 'SYN-002', displayName: 'Synthetic Ravi', workEmail: null, outcome: 'NO_WORK_EMAIL' },
  ],
  eligible: 1,
  refused: 1,
  maxRecipients: 500,
  tooMany: false,
};

type Reply = [number, unknown];
type Call = { method: string; path: string; body: Record<string, unknown> | undefined };
let calls: Call[] = [];
function serve(routes: Record<string, Reply | ((c: Call) => Reply)>) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://hrms.test');
      const call: Call = { method: init?.method ?? 'GET', path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      const route = routes[`${call.method} ${call.path}`];
      const [status, body] = route === undefined ? [404, { error: 'NOT_FOUND', message: 'Not found' }] : typeof route === 'function' ? route(call) : route;
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
}
const sends = () => calls.filter((c) => c.method === 'POST' && c.path === '/v1/hr-mail/messages');
const open = () => {
  const Page = SEND_MAIL_SCREENS[0]!.component;
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <MemoryRouter>
        <Page />
      </MemoryRouter>
    </QueryClientProvider>,
  );
};
const compose = (subject: string, message: string) => {
  const form = screen.getByRole('form', { name: 'Message' });
  fireEvent.change(within(form).getByLabelText('Subject'), { target: { value: subject } });
  fireEvent.change(within(form).getByLabelText('Message'), { target: { value: message } });
  return form;
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('CL-041 send mail', () => {
  it('CL-041: a menu screen under the confidential send right, in the employee lifecycle menu', () => {
    expect(SEND_MAIL_SCREENS.map((s) => [s.path, s.title, s.permission, s.nav])).toEqual([['/lifecycle/send-mail', 'Send mail', SEND_MAIL_PERMISSION, true]]);
    expect(SEND_MAIL_PERMISSION).toBe('hr_mail.send.message');
  });

  it('CL-041 DF12: with email off the screen says so plainly, recipients can still be reviewed, and nothing can be sent', async () => {
    serve({
      'GET /v1/hr-mail/channel': [200, OFF],
      'GET /v1/org/chart': [200, CHART],
      'GET /v1/hr-mail/messages': [200, { items: [] }],
      'POST /v1/hr-mail/recipients': [200, REVIEW],
    });
    open();
    expect((await screen.findByRole('alert')).textContent).toBe('Email is off: no mail server is configured, so nothing can be sent. Recipients can still be chosen and reviewed.');
    fireEvent.click(await screen.findByLabelText('Choose Synthetic Asha'));
    fireEvent.click(screen.getByRole('button', { name: 'Review 1 person chosen' }));
    await screen.findByRole('table', { name: 'Recipients' });
    const form = compose('Office closed on Friday', 'Please work from home.');
    expect((within(form).getByRole('button', { name: 'Send to 1 person' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(form);
    expect(screen.getByText('Sending is off while email is off.')).toBeTruthy();
    expect(sends()).toEqual([]);
    // No attachment is offered: the channel sends plain text only.
    expect(screen.queryByLabelText(/attachment/i)).toBeNull();
  });

  it('CL-041 BR-026: reviews the people chosen, shows who will not receive it and why, and sends only to the reviewed eligible recipients', async () => {
    serve({
      'GET /v1/hr-mail/channel': [200, ON],
      'GET /v1/org/chart': [200, CHART],
      'GET /v1/hr-mail/messages': [200, { items: [] }],
      'POST /v1/hr-mail/recipients': [200, REVIEW],
      'POST /v1/hr-mail/messages': [201, { id: 'm-1', recipientCount: 1, replayed: false, state: 'QUEUED' }],
    });
    open();
    await screen.findByText(/Email is on\./);
    fireEvent.change(screen.getByLabelText('Department'), { target: { value: 'Engineering' } });
    fireEvent.click(screen.getByLabelText('Choose everyone shown'));
    fireEvent.click(screen.getByRole('button', { name: 'Review 2 people chosen' }));
    const table = await screen.findByRole('table', { name: 'Recipients' });
    expect(within(table).getByText('No work email on record')).toBeTruthy();
    expect(within(table).getByText('asha@example.invalid')).toBeTruthy();
    expect(calls.find((c) => c.path === '/v1/hr-mail/recipients')!.body).toEqual({ employeeIds: [E1, E2] });
    const form = compose(' Office closed on Friday ', 'The office is closed this Friday.\nPlease work from home.');
    fireEvent.click(within(form).getByRole('button', { name: 'Send to 1 person' }));
    expect(await screen.findByText(/^Queued for 1 person\./)).toBeTruthy();
    const sent = sends()[0]!.body!;
    expect(sent).toMatchObject({ subject: 'Office closed on Friday', message: 'The office is closed this Friday.\nPlease work from home.', employeeIds: [E1] });
    expect(String(sent.idempotencyKey)).toMatch(/^hr-mail-/);
  });

  it('CL-041 FR-106: an uploaded list of employee codes is reviewed row by row; a refused send reads in words and is sent again under the same key', async () => {
    let first = true;
    serve({
      'GET /v1/hr-mail/channel': [200, ON],
      'GET /v1/org/chart': [403, { error: 'FORBIDDEN', message: 'Not permitted' }],
      'GET /v1/hr-mail/messages': [200, { items: [{ id: 'm-0', sentAt: '2026-11-10T09:00:00.000Z', recipientCount: 2, subject: 'Earlier note', delivery: { queued: 0, delivered: 1, failed: 0, suppressed: 1 } }] }],
      'POST /v1/hr-mail/recipients': [
        200,
        {
          recipients: [
            { row: 2, employeeId: E1, employeeCode: 'SYN-001', displayName: 'Synthetic Asha', workEmail: 'asha@example.invalid', outcome: 'ELIGIBLE' },
            { row: 3, employeeId: null, employeeCode: 'NOBODY', displayName: null, workEmail: null, outcome: 'NOT_FOUND' },
          ],
          eligible: 1,
          refused: 1,
          maxRecipients: 500,
          tooMany: false,
        },
      ],
      'POST /v1/hr-mail/messages': () => {
        if (first) {
          first = false;
          return [422, { error: 'CONTENT_NOT_ALLOWED', message: 'x', details: { rule: 'CURRENCY' } }];
        }
        return [201, { id: 'm-1', recipientCount: 1, replayed: false, state: 'QUEUED' }];
      },
    });
    open();
    expect(await screen.findByText(/upload a list of employee codes instead/)).toBeTruthy();
    const list = screen.getByRole('form', { name: 'Upload a list' });
    fireEvent.change(within(list).getByLabelText('List of employee codes (CSV)'), { target: { files: [new File(['employee_code\nSYN-001\nNOBODY\n'], 'codes.csv', { type: 'text/csv' })] } });
    fireEvent.click(within(list).getByRole('button', { name: 'Review the list' }));
    const table = await screen.findByRole('table', { name: 'Recipients' });
    expect(within(table).getByText('Not found among the people your role can reach')).toBeTruthy();
    expect(typeof calls.find((c) => c.path === '/v1/hr-mail/recipients')!.body!.contentBase64).toBe('string');
    const form = compose('Bonus', 'Your bonus of Rs 500 is due.');
    fireEvent.click(within(form).getByRole('button', { name: 'Send to 1 person' }));
    expect((await screen.findByRole('alert')).textContent).toContain('An email may not carry a currency.');
    fireEvent.click(within(form).getByRole('button', { name: 'Send to 1 person' }));
    await screen.findByText(/^Queued for 1 person\./);
    expect(sends()).toHaveLength(2);
    expect(sends()[1]!.body!.idempotencyKey).toBe(sends()[0]!.body!.idempotencyKey);
    // The sender's own messages with their delivery.
    const sent = screen.getByRole('table', { name: 'Messages you sent' });
    await waitFor(() => expect(sent.textContent).toContain('Earlier note'));
  });
});
