// The payment path C5 and C3 set (0131), for tests about other rules: preparation goes on to READY, and a release names its
// outcome actor, by default the releaser. payment-duties.api.test.ts holds those rules themselves.
import { expect } from 'vitest';
import type { Harness, TestActor } from '../../test/harness.js';

export interface PaymentBody {
  claimId: string;
  amount: string;
  paymentDate: string;
  idempotencyKey: string;
}

/** Prepares a payment and, when a new one was prepared, marks its batch READY as the same preparer. Answers the preparation. */
export async function prepareReady(h: Harness, a: TestActor, body: PaymentBody) {
  const res = await h.call(a, 'POST', '/v1/expense/payments', body);
  if (res.statusCode === 201) {
    const ready = await h.call(a, 'POST', `/v1/expense/payments/${res.json().instructionId}/ready`);
    expect(ready.statusCode, ready.body).toBe(200);
  }
  return res;
}

export const releaseNaming = (h: Harness, a: TestActor, instructionId: string, outcomeActor: TestActor = a) =>
  h.call(a, 'POST', `/v1/expense/payments/${instructionId}/release`, { outcomeActorUserId: outcomeActor.user });
