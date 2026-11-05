// ZT01 / ZT39 / ZT40 for sensitive changes: another company's private profile, requests, evidence and review tasks, by direct identifier.
// Synthetic data only: example addresses and made-up account identifiers.
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { type IsolationContext, itListsOnlyOwnRecords, itRefusesAnotherCompanyInTheHeader, itRefusesForeignRecords, type Probe, type World } from '../../test/isolation.fixtures.js';

let h: Harness;
let foreign: World;
let home: World;

const REVIEW: `${string}.${string}.${string}`[] = ['sensitive_change.review.private', 'sensitive_change.read.private', 'employee.read.private', 'employee.read.bank'];
const address = (city: string) => ({ line1: '12 Synthetic Street', city, postalCode: '560001', countryCode: 'IN' });
const pdf = () => Buffer.from(`%PDF-1.4\n% synthetic evidence ${uniq('e')}\n%%EOF\n`).toString('base64');
const bank = (accountIdentifier: string) => ({ holderName: 'Synthetic Person', accountIdentifier, routingReference: 'SYNT0000001', countryCode: 'IN' });

async function world(): Promise<World> {
  const company = await h.makeCompany();
  const hr = await h.actor(company, 'HR_ADMINISTRATOR', { extra: [...REVIEW, 'employee.create.personal', 'document.read.document', 'document.verify.document'] });
  expect((await h.call(hr, 'PUT', '/v1/workflows/sensitive_change/fallback-reviewers', { reviewers: [{ userId: hr.user, priority: 1 }] })).statusCode).toBe(200);
  const city = uniq('City');
  const person = async () => {
    const res = await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(company, { dateOfBirth: '1990-04-12' }));
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().id as string;
    await h.setStatus(company, id, 'ACTIVE_CONFIRMED');
    return { id, code: res.json().employeeCode as string, actor: await h.actor(company, 'EMPLOYEE', { employeeId: id }) };
  };
  const draft = async (a: TestActor, body: Record<string, unknown> = {}) => {
    const res = await h.call(a, 'POST', '/v1/me/sensitive-changes', { category: 'ADDRESS', reason: 'Synthetic update', values: address(city), ...body });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().requestId as string;
  };
  const submitted = async (a: TestActor, body: Record<string, unknown> = {}) => {
    const id = await draft(a, body);
    expect((await h.call(a, 'POST', `/v1/me/sensitive-changes/${id}/submit`, { expectedVersion: 1 })).statusCode).toBe(200);
    return id;
  };
  const taskOf = async (requestId: string) =>
    ((await h.call(hr, 'GET', '/v1/sensitive-changes/tasks/mine')).json().items as { taskId: string; request: { id: string } }[]).find((t) => t.request?.id === requestId)!.taskId;

  const [editor, submitter, withdrawer, reviser, reviewed, decided, evidenceOwner, fresh] = [await person(), await person(), await person(), await person(), await person(), await person(), await person(), await person()];
  const toEdit = await draft(editor.actor);
  const toSubmit = await draft(submitter.actor);
  const toWithdraw = await submitted(withdrawer.actor);
  const toRevise = await submitted(reviser.actor);
  const returned = await h.call(hr, 'POST', `/v1/sensitive-changes/tasks/${await taskOf(toRevise)}/decision`, { decision: 'RETURN', reason: 'Returned for correction (synthetic)', employeeMessage: 'Please correct (synthetic)', idempotencyKey: uniq('iso-sc-') });
  expect(returned.statusCode, returned.body).toBe(200);
  const toReview = await submitted(reviewed.actor);
  const toDecide = await submitted(decided.actor);
  const reviewTask = await taskOf(toReview);
  const decisionTask = await taskOf(toDecide);
  expect((await h.call(hr, 'POST', `/v1/sensitive-changes/tasks/${decisionTask}/start-review`)).statusCode).toBe(200);
  const document = (await h.call(evidenceOwner.actor, 'POST', `/v1/employees/${evidenceOwner.id}/documents`, { documentType: 'GENERAL', fileName: 'evidence.pdf', contentBase64: pdf() })).json().id as string;
  const withEvidence = await draft(evidenceOwner.actor, { category: 'BANK', values: bank('000123456789'), evidenceDocumentIds: [document] });

  return {
    company,
    actors: { hr, editor: editor.actor, submitter: submitter.actor, withdrawer: withdrawer.actor, reviser: reviser.actor, evidenceOwner: evidenceOwner.actor, fresh: fresh.actor },
    ids: { subject: reviewed.id, code: reviewed.code, city, toEdit, toSubmit, toWithdraw, toRevise, reviewTask, decisionTask, withEvidence, document, fresh: fresh.id },
    versions: { toEdit: 1, toSubmit: 1 },
  };
}

const ctx = (): IsolationContext => ({ h, foreign, home });

const PROBES: Probe[] = [
  { name: 'GET a foreign employee’s private profile', as: 'hr', method: 'GET', path: (w) => `/v1/employees/${w.ids.subject}/private-profile` },
  { name: 'GET a foreign employee’s sensitive changes (history)', as: 'hr', method: 'GET', path: (w) => `/v1/employees/${w.ids.subject}/sensitive-changes` },
  { name: 'GET a foreign request’s evidence file', as: 'evidenceOwner', method: 'GET', path: (w) => `/v1/sensitive-changes/${w.ids.withEvidence}/evidence/${w.ids.document}/content` },
  { name: 'PUT a foreign draft', as: 'editor', method: 'PUT', path: (w) => `/v1/me/sensitive-changes/${w.ids.toEdit}`, body: (w) => ({ values: address(w.ids.city!), reason: 'Isolation check (synthetic)', expectedVersion: w.versions.toEdit }) },
  { name: 'POST the submission of a foreign draft', as: 'submitter', method: 'POST', path: (w) => `/v1/me/sensitive-changes/${w.ids.toSubmit}/submit`, body: (w) => ({ expectedVersion: w.versions.toSubmit }) },
  { name: 'POST the withdrawal of a foreign request', as: 'withdrawer', method: 'POST', path: (w) => `/v1/me/sensitive-changes/${w.ids.toWithdraw}/withdraw` },
  { name: 'POST a revision of a foreign request', as: 'reviser', method: 'POST', path: (w) => `/v1/me/sensitive-changes/${w.ids.toRevise}/revise`, control: 201 },
  { name: 'POST the start of review of a foreign task', as: 'hr', method: 'POST', path: (w) => `/v1/sensitive-changes/tasks/${w.ids.reviewTask}/start-review` },
  { name: 'POST a decision on a foreign task', as: 'hr', method: 'POST', path: (w) => `/v1/sensitive-changes/tasks/${w.ids.decisionTask}/decision`, body: () => ({ decision: 'APPROVE', reason: 'Isolation check (synthetic)', idempotencyKey: uniq('iso-sc-') }) },
  {
    name: 'POST a draft citing a foreign document as evidence',
    as: 'fresh',
    method: 'POST',
    path: () => '/v1/me/sensitive-changes',
    body: (w) => ({ category: 'BANK', values: bank('000999888777'), reason: 'Isolation check (synthetic)', evidenceDocumentIds: [w.ids.document] }),
    refusal: [422, 'INVALID_EVIDENCE'],
    controlBody: () => ({ category: 'BANK', values: bank('000999888777'), reason: 'Isolation check (synthetic)' }),
    control: 201,
  },
];

beforeAll(async () => {
  h = await startHarness();
  foreign = await world();
  home = await world();
});

afterAll(async () => {
  await h?.stop();
});

describe('sensitive changes across companies (ZT01; ZT39; ZT40)', () => {
  itListsOnlyOwnRecords(ctx, [
    { name: 'GET /sensitive-changes/tasks/mine holds only the company’s own', as: 'hr', path: '/v1/sensitive-changes/tasks/mine', holds: (w) => [w.ids.reviewTask!], never: (w) => [w.ids.reviewTask!, w.ids.decisionTask!, w.ids.city!] },
    { name: 'GET /me/sensitive-changes holds only the employee’s own', as: 'withdrawer', path: '/v1/me/sensitive-changes', holds: (w) => [w.ids.toWithdraw!], never: (w) => [w.ids.toWithdraw!, w.ids.city!] },
    { name: 'GET /me/private-profile holds only the employee’s own', as: 'editor', path: '/v1/me/private-profile', never: (w) => [w.ids.city!, w.ids.subject!] },
  ]);
  itRefusesForeignRecords(ctx, PROBES);
  itRefusesAnotherCompanyInTheHeader(ctx, PROBES.filter((p) => p.as === 'hr'));
});
