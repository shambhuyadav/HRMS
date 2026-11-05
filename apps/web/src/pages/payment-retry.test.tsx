// The prepare form offers a failed payment as what the new one replaces (CI06; BR-025): optional, sent only when chosen, a changed choice is a
// new payment with a new key, and the server's three refusals read in plain words. Whether the link must be required is the owner's
// question, so nothing here assumes it. Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setSession } from '../api';
import { PaymentsPage } from './work';

vi.mock('../session', () => ({
  useSession: () => ({
    me: { accountKey: 'syn.user', companyName: 'Synthetic Co', roleCode: 'HR_ADMINISTRATOR', roleName: 'HR Administrator', scopeKind: 'COMPANY', employeeId: null, displayName: 'Synthetic Person' },
    can: (p: string) => ['payment.read.operational', 'payment.prepare.operational'].includes(p),
  }),
}));

type Call = { url: string; method: string; body: Record<string, unknown> | undefined };
type Reply = [number, unknown];
const PAYABLE = { claimId: 'cl-5', employeeCode: 'SYN-5', employeeName: 'Synthetic Five', purpose: 'Synthetic travel', paymentState: 'UNPAID', approvedAmount: '900.00', netPaid: '0.00', pending: '0.00', allocatable: '900.00', currency: 'INR' };
const row = (over: Record<string, unknown>) => ({ id: 'pi-1', amount: '900.00', currency: 'INR', state: 'FAILED', batchState: 'CLOSED', outcomeAssignedToMe: false, outcomeActorAccountKey: null, paymentDate: '2026-10-02', reversed: '0.00', retryOfInstructionId: null, ...over });

function serve(instructions: () => unknown[], prepare: (c: Call) => Reply = () => [201, { instructionId: 'pi-new', state: 'PREPARED', replayed: false }]) {
  const posts: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = { url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body as string) : undefined };
      if (call.method === 'POST') posts.push(call);
      const [status, body]: Reply = call.method === 'POST' ? prepare(call) : url.startsWith('/v1/expense/payables') ? [200, { items: [PAYABLE] }] : url.includes('/payments') ? [200, { items: instructions() }] : [404, { error: 'NOT_FOUND', message: 'Not found' }];
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
  return posts;
}
const open = async () => {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PaymentsPage />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByText('Manage'));
  await screen.findByLabelText('Amount');
};
const CHOICE = 'Replaces a failed payment';
const prepareNow = () => fireEvent.click(screen.getByText('Prepare payment'));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setSession(null);
});

describe('a replacement names the failed payment it replaces (CI06)', () => {
  it('is not offered when nothing has failed, and nothing extra is sent', async () => {
    const posts = serve(() => [row({ state: 'CONFIRMED' }), row({ id: 'pi-2', state: 'RELEASED' }), row({ id: 'pi-3', state: 'PREPARED', batchState: 'READY' })]);
    await open();
    await screen.findAllByText(/confirmed|released|prepared/i);
    expect(screen.queryByLabelText(CHOICE)).toBeNull();
    prepareNow();
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).not.toHaveProperty('retryOfInstructionId');
  });

  it('is offered but not assumed: left alone it is an ordinary payment; chosen, the link goes with the request', async () => {
    const posts = serve(() => [row({})]);
    await open();
    const choice = (await screen.findByLabelText(CHOICE)) as HTMLSelectElement;
    expect(choice.value).toBe('');
    expect(screen.getByRole('option', { name: /failed payment of .*900.* dated/i })).toBeTruthy();

    prepareNow();
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).not.toHaveProperty('retryOfInstructionId');

    fireEvent.change(await screen.findByLabelText(CHOICE), { target: { value: 'pi-1' } });
    prepareNow();
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]!.body).toMatchObject({ claimId: 'cl-5', retryOfInstructionId: 'pi-1' });
    // Prepared: the form starts over rather than carrying the link to the next payment.
    await waitFor(() => expect(((screen.getByLabelText(CHOICE)) as HTMLSelectElement).value).toBe(''));
  });

  it('a failed payment already replaced is not offered, and its replacement says what it is', async () => {
    serve(() => [row({}), row({ id: 'pi-2', state: 'PREPARED', batchState: 'READY', retryOfInstructionId: 'pi-1' })]);
    await open();
    expect(await screen.findByText('Replaces a failed payment')).toBeTruthy();
    expect(screen.queryByLabelText(CHOICE)).toBeNull();
  });

  it('changing the choice is another payment with a new key: the same key under another link would be refused', async () => {
    const posts = serve(() => [row({})], () => [503, { error: 'UNAVAILABLE', message: 'Synthetic gateway timeout' }]);
    await open();
    prepareNow();
    await screen.findByRole('alert');
    fireEvent.change(await screen.findByLabelText(CHOICE), { target: { value: 'pi-1' } });
    prepareNow();
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]!.body!.idempotencyKey).not.toBe(posts[0]!.body!.idempotencyKey);
    // The same request tried again is the same payment.
    prepareNow();
    await waitFor(() => expect(posts).toHaveLength(3));
    expect(posts[2]!.body!.idempotencyKey).toBe(posts[1]!.body!.idempotencyKey);
  });

  it.each([
    [409, 'RETRY_PRIOR_NOT_SETTLED', 'The earlier payment has no definitive failure recorded, so it cannot be replaced yet'],
    [422, 'RETRY_NOT_SAME_LIABILITY', 'A replacement replaces an earlier payment of this same claim'],
    [409, 'ALREADY_RETRIED', 'The earlier payment has already been replaced'],
  ] as const)('%s %s is shown in plain words', async (status, error, message) => {
    serve(() => [row({})], () => [status, { error, message }]);
    await open();
    fireEvent.change(await screen.findByLabelText(CHOICE), { target: { value: 'pi-1' } });
    prepareNow();
    expect((await screen.findByRole('alert')).textContent).toContain(message);
  });

  it('someone else replaced it meanwhile: refused in plain words, then the choice goes and the next attempt carries no stale link', async () => {
    let replaced = false;
    const posts = serve(
      () => (replaced ? [row({}), row({ id: 'pi-9', state: 'PREPARED', batchState: 'READY', retryOfInstructionId: 'pi-1' })] : [row({})]),
      (c) => {
        if (!c.body!.retryOfInstructionId) return [201, { instructionId: 'pi-new', state: 'PREPARED', replayed: false }];
        replaced = true;
        return [409, { error: 'ALREADY_RETRIED', message: 'The earlier payment has already been replaced' }];
      },
    );
    await open();
    fireEvent.change(await screen.findByLabelText(CHOICE), { target: { value: 'pi-1' } });
    prepareNow();
    expect((await screen.findByRole('alert')).textContent).toContain('already been replaced');
    await waitFor(() => expect(screen.queryByLabelText(CHOICE)).toBeNull());
    prepareNow();
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]!.body).not.toHaveProperty('retryOfInstructionId');
  });
});
