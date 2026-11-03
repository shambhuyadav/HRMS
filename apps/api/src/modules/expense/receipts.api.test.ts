// Expense receipt files over HTTP (DF06, DF02, FR-057, FR-069): a receipt opens only with access to its parent claim,
// download headers for any stored file name (sec-1, web-7), the content-read audit written only once the bytes were
// fetched, a recorded denial outside row scope (sec-5, FR-098) and the receipt evidence the verification log claims
// (brd-10). Synthetic data only: the bytes are synthetic PDF, JPEG and PNG headers and every name is invented.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_UPLOAD_BYTES } from '../../storage/files.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';

let h: Harness;
let A: Company;
let engClaimant: TestActor;
let finClaimant: TestActor;
let reviewerEng: TestActor;
let manager: TestActor;

const pdf =(note: string = randomUUID()) => Buffer.from(`%PDF-1.4\n% synthetic receipt ${note}\n%%EOF\n`);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('synthetic png receipt')]);
const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64');
/** A synthetic PDF of exactly `size` bytes. */
const sizedPdf = (size: number) => {
  const bytes = Buffer.alloc(size, 0x20);
  bytes.write('%PDF-1.4\n');
  return bytes;
};
const daysAgo = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
const syntheticLine = (extra: Record<string, unknown> = {}) => ({
  category: 'OTHER',
  expenseDate: daysAgo(2),
  merchant: 'Synthetic Merchant',
  grossAmount: '10',
  claimedAmount: '10',
  description: 'Receipt file check (synthetic)',
  ...extra,
});

const uploadReceipt = (a: TestActor, fileName: string, bytes: Buffer) => h.call(a, 'POST', '/v1/expense/receipts', { fileName, contentBase64: b64(bytes) });

/** Drafts a one-line claim as the claimant and returns the claim and line ids. */
async function draftClaim(a: TestActor, line: Record<string, unknown>): Promise<{ claimId: string; lineId: string }> {
  const draft = await h.call(a, 'POST', '/v1/expense/claims', { purpose: 'Receipt file checks (synthetic)', currency: 'INR', lines: [line] });
  expect(draft.statusCode).toBe(201);
  const claimId = draft.json().claimId as string;
  return { claimId, lineId: (await h.call(a, 'GET', `/v1/expense/claims/${claimId}`)).json().lines[0].id as string };
}
const draftLine = async (a: TestActor, line: Record<string, unknown>) => (await draftClaim(a, line)).lineId;

const submitClaim = async (a: TestActor, claimId: string) => {
  const version = (await h.call(a, 'GET', `/v1/expense/claims/${claimId}`)).json().version as number;
  expect((await h.call(a, 'POST', `/v1/expense/claims/${claimId}/submit`, { expectedVersion: version })).statusCode).toBe(200);
};

/** Uploads a receipt as the claimant and attaches it to the line of a fresh draft. */
async function receiptOnDraft(a: TestActor, fileName: string, bytes: Buffer = pdf()) {
  const upload = await uploadReceipt(a, fileName, bytes);
  expect(upload.statusCode).toBe(201);
  const receiptId = upload.json().receiptId as string;
  return { receiptId, upload: upload.json() as { mediaType: string; byteSize: number }, ...(await draftClaim(a, syntheticLine({ receipt: { receiptId } }))) };
}

/** A receipt on the line of a submitted claim, which is what a reviewer can open. */
async function receiptOnLine(a: TestActor, fileName: string, bytes: Buffer = pdf()) {
  const draft = await receiptOnDraft(a, fileName, bytes);
  await submitClaim(a, draft.claimId);
  return draft;
}

const receipt = (a: TestActor, lineId: string) => h.call(a, 'GET', `/v1/expense/lines/${lineId}/receipt`);
const receiptAudits = async (action: string, recordKey: string) =>
  Number(
    (
      await h.one<{ n: string }>(`select count(*) as n from audit_event where company_id = $1 and resource_code = 'expense_receipt' and action = $2 and record_key = $3`, [
        A.id,
        action,
        recordKey,
      ])
    ).n,
  );
const denialsBy = async (a: TestActor) =>
  (
    await h.db.query<{ record_key: string; after_values: Record<string, unknown> }>(
      `select record_key, after_values from audit_event where company_id = $1 and actor_user_id = $2 and resource_code = 'expense_receipt' and action = 'ACCESS_DENIED'`,
      [A.id, a.user],
    )
  ).rows;

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  const hr = await h.actor(A, 'HR_ADMINISTRATOR');
  const employee = async (overrides: Record<string, unknown> = {}) => {
    const id = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, overrides))).json().id as string;
    await h.setStatus(A, id, 'ACTIVE_CONFIRMED');
    return id;
  };
  // Both claimants report to one manager, so their claims can be submitted.
  const managerEmp = await employee();
  const claimantOf = async (overrides: Record<string, unknown> = {}) => {
    const id = await employee(overrides);
    await h.call(hr, 'POST', `/v1/employees/${id}/manager`, { managerEmployeeId: managerEmp, effectiveFrom: '2026-01-05' });
    return h.actor(A, 'EMPLOYEE', { employeeId: id });
  };
  manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp, extra: ['expense.view_receipt.receipt'] });
  engClaimant = await claimantOf();
  finClaimant = await claimantOf({ departmentId: A.financeDept });
  // A reviewer who can open the claim and holds the confidential receipt grant, filtered to the ENG department (row scope).
  reviewerEng = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['expense.read.operational', 'expense.view_receipt.receipt'], departmentFilter: A.dept });
  const policy = (await h.call(hr, 'GET', '/v1/expense/policies')).json().items[0];
  expect((await h.call(hr, 'POST', `/v1/expense/policies/${policy.id}/activate`, { expectedVersion: policy.version })).statusCode).toBe(200);
});

afterAll(async () => {
  await h?.stop();
});

describe('a receipt opens only with access to its parent claim (FR-069, DF02)', () => {
  const claimOf = (a: TestActor, claimId: string) => h.call(a, 'GET', `/v1/expense/claims/${claimId}`);

  it('the receipt grant without the claim read permission opens nothing, and the attempt is recorded', async () => {
    const receiptOnly = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['expense.view_receipt.receipt'] });
    const { receiptId, claimId, lineId } = await receiptOnLine(engClaimant, 'no-claim-read.pdf');
    expect((await claimOf(receiptOnly, claimId)).statusCode).toBe(403);
    expect((await receipt(receiptOnly, lineId)).statusCode).toBe(403);
    const denied = await h.db.query<{ after_values: { action: string } }>(
      `select after_values from audit_event where company_id = $1 and actor_user_id = $2 and resource_code = 'expense' and action = 'ACCESS_DENIED' and record_key = $3`,
      [A.id, receiptOnly.user, lineId],
    );
    expect(denied.rows.map((r) => r.after_values.action)).toContain('read');
    expect(await receiptAudits('READ_CONTENT', receiptId)).toBe(0);
  });

  it('the claim read permission without the receipt grant does not open the file either', async () => {
    // A payment operator: DF02 limits reading a claim to the claimant, its assigned reviewers and payment operators.
    const claimOnly = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['expense.read.operational', 'payment.read.operational'] });
    const { claimId, lineId } = await receiptOnLine(engClaimant, 'no-receipt-grant.pdf');
    expect((await claimOf(claimOnly, claimId)).statusCode).toBe(200);
    expect((await receipt(claimOnly, lineId)).statusCode).toBe(403);
  });

  it('grants held on another assignment of the same person do not add up', async () => {
    const claimOnly = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['expense.read.operational'] });
    const receiptOnly = await h.actor(A, 'HR_ADMINISTRATOR', { user: claimOnly.user, extra: ['expense.view_receipt.receipt'] });
    const { lineId } = await receiptOnLine(engClaimant, 'two-assignments.pdf');
    expect((await receipt(claimOnly, lineId)).statusCode).toBe(403);
    expect((await receipt(receiptOnly, lineId)).statusCode).toBe(403);
  });

  it('a never-submitted draft is the claimant’s own: a reviewer or manager gets not found and the attempt is recorded, until it is submitted', async () => {
    const { receiptId, claimId, lineId } = await receiptOnDraft(engClaimant, 'still-a-draft.pdf');
    expect((await receipt(engClaimant, lineId)).statusCode).toBe(200);
    for (const other of [reviewerEng, manager]) {
      expect((await receipt(other, lineId)).statusCode).toBe(404);
      const rows = (await denialsBy(other)).filter((r) => r.record_key === receiptId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.after_values).toMatchObject({ action: 'read', reason: 'CLAIM_NOT_SUBMITTED' });
    }
    expect(await receiptAudits('READ_CONTENT', receiptId)).toBe(1); // the claimant's read only
    await submitClaim(engClaimant, claimId);
    expect((await receipt(reviewerEng, lineId)).statusCode).toBe(200);
    expect((await receipt(manager, lineId)).statusCode).toBe(200);
  });
});

describe('receipt download headers (sec-1, web-7)', () => {
  it('serves a receipt whose name holds characters beyond Latin-1 with an RFC 6266 / 5987 disposition', async () => {
    const bytes = pdf();
    const { receiptId, lineId } = await receiptOnLine(engClaimant, 'bill – March.pdf', bytes);
    const res = await receipt(reviewerEng, lineId);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toBe(`attachment; filename="bill _ March.pdf"; filename*=UTF-8''bill%20%E2%80%93%20March.pdf`);
    expect(res.rawPayload.equals(bytes)).toBe(true);
    expect(await receiptAudits('READ_CONTENT', receiptId)).toBe(1);
  });

  it('serves a receipt name with an em dash, and a stored name holding DEL', async () => {
    const { receiptId, lineId } = await receiptOnLine(engClaimant, 'taxi — night fare.pdf');
    const dash = await receipt(reviewerEng, lineId);
    expect(dash.statusCode).toBe(200);
    expect(dash.headers['content-disposition']).toBe(`attachment; filename="taxi _ night fare.pdf"; filename*=UTF-8''taxi%20%E2%80%94%20night%20fare.pdf`);
    // Rows written before the upload pattern was tightened can hold DEL.
    await h.db.query(`update attachment set file_name = $2 where id = $1`, [receiptId, 'old\x7freceipt.pdf']);
    const del = await receipt(reviewerEng, lineId);
    expect(del.statusCode).toBe(200);
    expect(del.headers['content-disposition']).toBe(`attachment; filename="old_receipt.pdf"; filename*=UTF-8''old%7Freceipt.pdf`);
    expect(await receiptAudits('READ_CONTENT', receiptId)).toBe(2);
  });

  it('refuses DEL in an uploaded receipt name', async () => {
    const res = await uploadReceipt(engClaimant, 'bad\x7fname.pdf', pdf());
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('INVALID_REQUEST');
  });

  it('records a receipt read only once the bytes were fetched', async () => {
    const { receiptId, lineId } = await receiptOnLine(engClaimant, 'lost.pdf');
    // A reference the store does not hold (for example a file lost from the store) makes the read fail.
    await h.db.query(`update attachment set content_reference = $2 where id = $1`, [receiptId, `mem:${'0'.repeat(64)}`]);
    expect((await receipt(reviewerEng, lineId)).statusCode).toBe(500);
    expect(await receiptAudits('READ_CONTENT', receiptId)).toBe(0);
  });
});

describe('a denial outside row scope is recorded (sec-5, FR-098)', () => {
  it('a reviewer limited to ENG gets not found for a FIN claimant’s receipt, and the attempt is recorded', async () => {
    const { receiptId, lineId } = await receiptOnLine(finClaimant, 'fin-receipt.pdf');
    expect((await receipt(reviewerEng, lineId)).statusCode).toBe(404);
    const rows = (await denialsBy(reviewerEng)).filter((r) => r.record_key === receiptId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.after_values).toMatchObject({ action: 'read', reason: 'OUT_OF_SCOPE' });
    // Redacted metadata only: no file name or content in a denial.
    expect(JSON.stringify(rows)).not.toMatch(/fin-receipt|PDF/);
    expect(await receiptAudits('READ_CONTENT', receiptId)).toBe(0);
  });

  it('an unknown line or a line without a receipt is plain not found, with no denial recorded', async () => {
    const before = (await denialsBy(reviewerEng)).length;
    expect((await receipt(reviewerEng, randomUUID())).statusCode).toBe(404);
    const bare = await draftLine(engClaimant, syntheticLine());
    expect((await receipt(reviewerEng, bare)).statusCode).toBe(404);
    expect((await denialsBy(reviewerEng)).length).toBe(before);
  });
});

describe('receipt file evidence (DF06, FR-057, brd-10)', () => {
  it('serves receipt content as a no-store, nosniff attachment', async () => {
    const { lineId } = await receiptOnLine(engClaimant, 'parking.pdf');
    const res = await receipt(reviewerEng, lineId);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="parking\.pdf"/);
  });

  it('accepts JPEG and PNG receipts by their magic bytes and refuses a renamed text file', async () => {
    const accepted = [
      [jpeg, 'image/jpeg', 'meal.jpg'],
      [png, 'image/png', 'toll.png'],
    ] as const;
    for (const [bytes, mediaType, fileName] of accepted) {
      const { upload, lineId } = await receiptOnLine(engClaimant, fileName, bytes);
      expect(upload).toMatchObject({ mediaType, byteSize: bytes.length });
      const served = await receipt(reviewerEng, lineId);
      expect(served.headers['content-type']).toBe(mediaType);
      expect(served.rawPayload.equals(bytes)).toBe(true);
    }
    for (const fileName of ['fare.jpg', 'fare.png', 'fare.pdf']) {
      const res = await uploadReceipt(engClaimant, fileName, Buffer.from('plain synthetic text, not a receipt'));
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toBe('UNSUPPORTED_FILE');
    }
  });

  it('refuses receipts over 10 MB; exactly 10 MB is accepted', async () => {
    const atLimit = await uploadReceipt(engClaimant, 'at-limit.pdf', sizedPdf(MAX_UPLOAD_BYTES));
    expect(atLimit.statusCode).toBe(201);
    expect(atLimit.json()).toMatchObject({ mediaType: 'application/pdf', byteSize: 10 * 1024 * 1024 });
    const over = await uploadReceipt(engClaimant, 'over-limit.pdf', sizedPdf(MAX_UPLOAD_BYTES + 1));
    expect(over.statusCode).toBe(422);
    expect(over.json().error).toBe('FILE_SIZE');
    const stored = await h.one<{ n: string }>(`select count(*) as n from attachment where company_id = $1 and file_name = 'over-limit.pdf'`, [A.id]);
    expect(Number(stored.n)).toBe(0);
  });
});
