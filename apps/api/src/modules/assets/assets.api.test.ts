// Asset register, custody and custody requests over HTTP (FR-110 "show own assigned assets and acknowledgments ...
// Employee cannot transfer/write off assets"; H3 TN16 "Own assigned items, issue/return history and acknowledgment;
// custody request only, no write-off/transfer approval"; H1/BR-053; DF02; DF03; DF04; DF08; C4). Synthetic data only:
// made-up item codes and serials, example.test people.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHECK_VIOLATION, expectSqlError, uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import type { PermissionKey } from '../access/baseline.js';
import { dispatchOutbox } from '../notification/dispatcher.js';
import { isModuleActive } from '../registry.js';
import { assetsStillHeld } from './service.js';

const ADMIN: PermissionKey[] = ['asset.read.operational', 'asset.manage.operational', 'asset.custody.operational', 'asset_request.read.operational', 'asset_request.decide.operational'];

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const key = () => uniq('asset-key-');

describe.runIf(isModuleActive('assets'))('assets (FR-110, H3 TN16)', () => {
  let h: Harness;
  let A: Company;
  let B: Company;
  let admin: TestActor; // HR Administrator with the asset duties; also an employee of A (own Employee context below)
  let admin2: TestActor;
  let sysAdmin: TestActor;
  let hrNoGrant: TestActor;
  let filteredAdmin: TestActor;
  let manager: TestActor;
  let bAdmin: TestActor;
  let employee: TestActor;
  let colleague: TestActor;
  let adminAsEmployee: TestActor;
  let employeeEmp: string;
  let colleagueEmp: string;
  let adminEmp: string;
  let separatedEmp: string;
  let today: string;

  type Custody = { custodyId: string; assetCode: string; status: string; issuedOn: string; issueCondition: string; acknowledgedAt: string | null; returnedOn: string | null; returnCondition: string | null; requestId: string | null };
  type Task = { taskId: string; request: (Record<string, unknown> & { id: string }) | null };

  const person = async (opts: { departmentId?: string; status?: string; name?: string } = {}) => {
    const res = await h.call(admin, 'POST', '/v1/employees', h.newEmployeeBody(A, { displayName: opts.name ?? 'Synthetic Person', ...(opts.departmentId ? { departmentId: opts.departmentId } : {}) }));
    expect(res.statusCode, res.body).toBe(201);
    await h.setStatus(A, res.json().id, opts.status ?? 'ACTIVE_CONFIRMED');
    return res.json().id as string;
  };
  const newAsset = async (body: Record<string, unknown> = {}) => {
    const res = await h.call(admin, 'POST', '/v1/assets', { assetCode: uniq('SYN-'), categoryCode: 'GENERAL', description: 'Synthetic laptop', ...body });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: string; assetCode: string; version: number; state: string };
  };
  const issue = (a: TestActor, assetId: string, body: Record<string, unknown>) =>
    h.call(a, 'POST', `/v1/assets/${assetId}/issue`, { condition: 'Good working order (synthetic)', idempotencyKey: key(), ...body });
  const giveBack = (a: TestActor, assetId: string, body: Record<string, unknown> = {}) =>
    h.call(a, 'POST', `/v1/assets/${assetId}/return`, { condition: 'Returned in good order (synthetic)', idempotencyKey: key(), ...body });
  const ownAssets = async (a: TestActor, employeeId: string) => (await h.call(a, 'GET', `/v1/employees/${employeeId}/assets`)).json().items as Custody[];
  const acknowledge = (a: TestActor, custodyId: string) => h.call(a, 'POST', '/v1/me/asset-acknowledgments', { custodyId });
  const ask = (a: TestActor, body: Record<string, unknown> = {}) =>
    h.call(a, 'POST', '/v1/me/asset-requests', { categoryCode: 'GENERAL', itemDescription: 'Synthetic monitor', reason: 'Synthetic business need', idempotencyKey: key(), ...body });
  const tasks = async (a: TestActor) => (await h.call(a, 'GET', '/v1/asset-requests/tasks/mine')).json().items as Task[];
  const taskFor = async (a: TestActor, requestId: string) => (await tasks(a)).find((t) => t.request?.id === requestId);
  const decide = (a: TestActor, taskId: string, body: Record<string, unknown>) => h.call(a, 'POST', `/v1/asset-requests/tasks/${taskId}/decision`, { idempotencyKey: key(), ...body });
  const inbox = async (a: TestActor) => (await h.call(a, 'GET', '/v1/me/notifications')).json().items as { category: string; title: string | null; body: string }[];
  const myRequests = async (a: TestActor, employeeId: string) => (await h.call(a, 'GET', `/v1/employees/${employeeId}/asset-requests`)).json().items as Record<string, unknown>[];
  const pending = async (a: TestActor) =>
    ((await h.call(a, 'GET', '/v1/dashboard')).json().widgets as { code: string; value?: number }[]).find((w) => w.code === 'MY_REQUESTS')?.value;
  const trail = async (recordKeys: string[]) =>
    (
      await h.one<{ t: string }>(
        `select coalesce(string_agg(coalesce(before_values::text, '') || ' ' || coalesce(after_values::text, '') || ' ' || coalesce(reason, ''), ' '), '') as t
           from audit_event where company_id = $1 and record_key = any($2::uuid[])`,
        [A.id, recordKeys],
      )
    ).t;
  /** Business actions recorded on a record, oldest first (refused attempts are recorded separately as ACCESS_DENIED). */
  const actions = async (resource: string, recordKey: string) =>
    (
      await h.db.query<{ action: string }>(
        `select action from audit_event where company_id = $1 and resource_code = $2 and record_key = $3 and action <> 'ACCESS_DENIED' order by occurred_at, id`,
        [A.id, resource, recordKey],
      )
    ).rows.map((r) => r.action);

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    B = await h.makeCompany();
    admin = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ADMIN });
    admin2 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ADMIN });
    sysAdmin = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { extra: ['asset.read.operational', 'asset.custody.operational'] });
    hrNoGrant = await h.actor(A, 'HR_ADMINISTRATOR');
    filteredAdmin = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ADMIN, departmentFilter: A.dept });
    bAdmin = await h.actor(B, 'HR_ADMINISTRATOR', { extra: ADMIN });
    employeeEmp = await person({ name: 'Ena Employee (synthetic)' });
    colleagueEmp = await person({ name: 'Cal Colleague (synthetic)' });
    separatedEmp = await person({ name: 'Sam Separated (synthetic)', status: 'INACTIVE_SEPARATED' });
    adminEmp = await person({ name: 'Ada Admin (synthetic)' });
    employee = await h.actor(A, 'EMPLOYEE', { employeeId: employeeEmp });
    colleague = await h.actor(A, 'EMPLOYEE', { employeeId: colleagueEmp });
    // The administrator's own Employee context (same user): their own requests and items (BR-055).
    adminAsEmployee = await h.actor(A, 'EMPLOYEE', { user: admin.user, employeeId: adminEmp });
    manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: await person({ name: 'Mo Manager (synthetic)' }) });
    const routed = await h.call(admin, 'PUT', '/v1/workflows/asset_request/fallback-reviewers', {
      reviewers: [
        { userId: admin.user, priority: 1 },
        { userId: admin2.user, priority: 2 },
      ],
    });
    expect(routed.statusCode, routed.body).toBe(200);
    today = (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [A.id])).d;
  });

  afterAll(async () => {
    await h?.stop();
  });

  describe('register (Admin, unrestricted company scope)', () => {
    it('creates, lists and corrects items; codes are normalised and permanent; categories are controlled', async () => {
      const created = await h.call(admin, 'POST', '/v1/assets', { assetCode: ' lap-0001 ', categoryCode: 'GENERAL', description: ' Synthetic laptop ', identifier: '000123' });
      expect(created.statusCode, created.body).toBe(201);
      const asset = created.json();
      expect(asset).toMatchObject({ assetCode: 'LAP-0001', category: { code: 'GENERAL', label: 'General item' }, description: 'Synthetic laptop', identifier: '000123', state: 'IN_STOCK', holder: null, version: 1 });
      expect((await h.call(admin, 'POST', '/v1/assets', { assetCode: 'LAP-0001', categoryCode: 'GENERAL', description: 'Another' })).json().error).toBe('ASSET_CODE_EXISTS');
      expect((await h.call(admin, 'POST', '/v1/assets', { assetCode: 'LAP-0002', categoryCode: 'NOT_A_CATEGORY', description: 'Synthetic' })).json().error).toBe('INVALID_CATEGORY');
      expect((await h.call(admin, 'POST', '/v1/assets', { assetCode: 'bad code!', categoryCode: 'GENERAL', description: 'Synthetic' })).json().error).toBe('INVALID_ASSET_CODE');
      expect((await h.call(admin, 'POST', '/v1/assets', { assetCode: 'LAP-0003', categoryCode: 'GENERAL', description: '   ' })).json().error).toBe('INVALID_DESCRIPTION');

      const listed = (await h.call(admin, 'GET', '/v1/assets?search=lap-0001')).json();
      expect(listed).toMatchObject({ total: 1, items: [{ id: asset.id, assetCode: 'LAP-0001' }] });
      // Wildcards match literally.
      expect((await h.call(admin, 'GET', `/v1/assets?search=${encodeURIComponent('%')}`)).json().total).toBe(0);
      expect((await h.call(admin, 'GET', '/v1/asset-categories')).json().items).toEqual(expect.arrayContaining([{ code: 'GENERAL', label: 'General item' }]));

      const patched = await h.call(admin, 'PATCH', `/v1/assets/${asset.id}`, { expectedVersion: 1, description: 'Synthetic laptop, 14 inch', identifier: null });
      expect(patched.statusCode, patched.body).toBe(200);
      expect(patched.json()).toMatchObject({ description: 'Synthetic laptop, 14 inch', identifier: null, version: 2 });
      expect((await h.call(admin, 'PATCH', `/v1/assets/${asset.id}`, { expectedVersion: 1, description: 'Stale' })).json().error).toBe('STALE_VERSION');
      expect((await h.call(admin, 'PATCH', `/v1/assets/${asset.id}`, { expectedVersion: 2, description: 'Synthetic laptop, 14 inch' })).json().error).toBe('NO_CHANGE');
      expect(await actions('asset', asset.id)).toEqual(['CREATE', 'UPDATE']);
      const update = await h.one<{ before_values: unknown; after_values: unknown; prior_version: number; new_version: number }>(
        `select before_values, after_values, prior_version, new_version from audit_event where record_key = $1 and action = 'UPDATE'`,
        [asset.id],
      );
      expect(update).toEqual({
        before_values: { operational: { description: 'Synthetic laptop', identifier: '000123' } },
        after_values: { operational: { description: 'Synthetic laptop, 14 inch', identifier: null } },
        prior_version: 1,
        new_version: 2,
      });
    });

    it('refuses other roles, missing grants, narrower scopes and other companies', async () => {
      const asset = await newAsset();
      for (const a of [employee, hrNoGrant, manager]) {
        expect((await h.call(a, 'GET', '/v1/assets')).statusCode).toBe(403);
        expect((await h.call(a, 'POST', '/v1/assets', { assetCode: uniq('X-'), categoryCode: 'GENERAL', description: 'x' })).statusCode).toBe(403);
        expect((await h.call(a, 'GET', `/v1/assets/${asset.id}`)).statusCode).toBe(403);
      }
      // The register is company property and shows holders: a department-filtered assignment is refused, and recorded.
      expect((await h.call(filteredAdmin, 'GET', '/v1/assets')).statusCode).toBe(403);
      expect((await issue(filteredAdmin, asset.id, { employeeId: employeeEmp })).statusCode).toBe(403);
      const denial = await h.one<{ after_values: { reason: string } }>(
        `select after_values from audit_event where company_id = $1 and actor_user_id = $2 and action = 'ACCESS_DENIED' and resource_code = 'asset' order by occurred_at desc limit 1`,
        [A.id, filteredAdmin.user],
      );
      expect(denial.after_values.reason).toBe('OUT_OF_SCOPE');
      // A System Administrator holding only read and custody cannot keep the register.
      expect((await h.call(sysAdmin, 'GET', `/v1/assets/${asset.id}`)).statusCode).toBe(200);
      expect((await h.call(sysAdmin, 'PATCH', `/v1/assets/${asset.id}`, { expectedVersion: 1, description: 'x' })).statusCode).toBe(403);
      // Another company's administrator never reaches this company's items or employees.
      expect((await h.call(bAdmin, 'GET', `/v1/assets/${asset.id}`)).statusCode).toBe(404);
      expect((await issue(bAdmin, asset.id, { employeeId: employeeEmp })).statusCode).toBe(404);
      expect((await h.call(bAdmin, 'GET', `/v1/employees/${employeeEmp}/assets`)).statusCode).toBe(404);
      expect((await h.call(bAdmin, 'GET', '/v1/assets')).json().items.some((x: { id: string }) => x.id === asset.id)).toBe(false);
    });
  });

  describe('custody: issue, acknowledgment, return (H3 TN16)', () => {
    it('issues to one holder, lets the employee acknowledge once and records the return; history is kept', async () => {
      const asset = await newAsset({ identifier: '0042' });
      const issued = await issue(admin, asset.id, { employeeId: employeeEmp, issuedOn: today, idempotencyKey: 'issue-key-0001' });
      expect(issued.statusCode, issued.body).toBe(201);
      expect(issued.json()).toMatchObject({ assetId: asset.id, employeeId: employeeEmp, issuedOn: today, state: 'ISSUED', replayed: false });
      const custodyId = issued.json().custodyId as string;
      // An idempotent replay returns the recorded issue; the same key cannot issue another item.
      const replay = await issue(admin, asset.id, { employeeId: employeeEmp, idempotencyKey: 'issue-key-0001' });
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toMatchObject({ custodyId, replayed: true });
      const other = await newAsset();
      expect((await issue(admin, other.id, { employeeId: employeeEmp, idempotencyKey: 'issue-key-0001' })).json().error).toBe('IDEMPOTENCY_KEY_REUSED');
      // One holder at a time.
      expect((await issue(admin, asset.id, { employeeId: colleagueEmp })).json().error).toBe('ASSET_NOT_AVAILABLE');
      expect(await h.one<{ n: number }>(`select count(*)::int as n from asset_custody where asset_id = $1`, [asset.id])).toEqual({ n: 1 });

      // The employee sees their own item, with its condition, and acknowledges receipt once.
      const mine = await ownAssets(employee, employeeEmp);
      expect(mine.find((c) => c.custodyId === custodyId)).toMatchObject({ assetCode: asset.assetCode, status: 'HELD', issuedOn: today, issueCondition: 'Good working order (synthetic)', acknowledgedAt: null });
      expect((await h.call(admin, 'GET', `/v1/assets/${asset.id}`)).json().holder).toMatchObject({ custodyId, employeeId: employeeEmp, acknowledgedAt: null });
      // Another employee neither sees nor acknowledges it (altered identifiers read as missing).
      expect((await h.call(colleague, 'GET', `/v1/employees/${employeeEmp}/assets`)).statusCode).toBe(404);
      expect((await acknowledge(colleague, custodyId)).statusCode).toBe(404);
      // The administrator's context cannot acknowledge on the employee's behalf.
      expect((await acknowledge(admin, custodyId)).statusCode).toBe(403);
      const ack = await acknowledge(employee, custodyId);
      expect(ack.statusCode, ack.body).toBe(201);
      expect(ack.json()).toMatchObject({ custodyId, replayed: false });
      const again = await acknowledge(employee, custodyId);
      expect(again.statusCode).toBe(200);
      expect(again.json()).toEqual({ custodyId, acknowledgedAt: ack.json().acknowledgedAt, replayed: true });
      expect(await h.one<{ n: number }>(`select count(*)::int as n from asset_custody_acknowledgment where custody_id = $1`, [custodyId])).toEqual({ n: 1 });

      // Return: closes the custody once; replays change nothing.
      expect((await giveBack(admin, asset.id, { returnedOn: addDays(today, 1) })).json().error).toBe('DATE_IN_FUTURE');
      const returned = await giveBack(admin, asset.id, { returnedOn: today, idempotencyKey: 'return-key-0001' });
      expect(returned.statusCode, returned.body).toBe(200);
      expect(returned.json()).toMatchObject({ custodyId, returnedOn: today, state: 'RETURNED_TO_STOCK', replayed: false });
      expect((await giveBack(admin, asset.id, { idempotencyKey: 'return-key-0001' })).json()).toMatchObject({ custodyId, replayed: true });
      expect((await giveBack(admin, asset.id)).json().error).toBe('ASSET_NOT_ISSUED');
      const history = await ownAssets(employee, employeeEmp);
      expect(history.find((c) => c.custodyId === custodyId)).toMatchObject({ status: 'RETURNED', returnedOn: today, returnCondition: 'Returned in good order (synthetic)', acknowledgedAt: ack.json().acknowledgedAt });

      // Reissued to someone else: the earlier holder keeps the history, the item has both custody records.
      const second = await issue(admin, asset.id, { employeeId: colleagueEmp });
      expect(second.statusCode, second.body).toBe(201);
      const detail = (await h.call(admin, 'GET', `/v1/assets/${asset.id}`)).json();
      expect(detail).toMatchObject({ state: 'ISSUED', holder: { employeeId: colleagueEmp } });
      expect(detail.custody.map((c: { employeeId: string; status: string }) => [c.employeeId, c.status])).toEqual([
        [colleagueEmp, 'HELD'],
        [employeeEmp, 'RETURNED'],
      ]);
      expect((await ownAssets(employee, employeeEmp)).some((c) => c.custodyId === second.json().custodyId)).toBe(false);

      // Audit: who did what, with the operational values; every change of the item bumps its version.
      expect(await actions('asset_custody', custodyId)).toEqual(['ISSUE', 'ACKNOWLEDGE', 'RETURN']);
      expect(await actions('asset', asset.id)).toEqual(['CREATE', 'ISSUE', 'RETURN', 'ISSUE']);
      const issueAudit = await h.one<{ actor_user_id: string; after_values: Record<string, Record<string, unknown>> }>(
        `select actor_user_id, after_values from audit_event where record_key = $1 and action = 'ISSUE'`,
        [custodyId],
      );
      expect(issueAudit).toMatchObject({ actor_user_id: admin.user, after_values: { operational: { assetId: asset.id, employeeId: employeeEmp, issuedOn: today } } });
      const ackAudit = await h.one<{ actor_user_id: string }>(`select actor_user_id from audit_event where record_key = $1 and action = 'ACKNOWLEDGE'`, [custodyId]);
      expect(ackAudit.actor_user_id).toBe(employee.user);
      expect((await h.one<{ version: number }>(`select version from asset where id = $1`, [asset.id])).version).toBe(4);
    });

    it('checks dates, eligibility and self-custody', async () => {
      const asset = await newAsset();
      expect((await issue(admin, asset.id, { employeeId: employeeEmp, issuedOn: addDays(today, 1) })).json().error).toBe('DATE_IN_FUTURE');
      expect((await issue(admin, asset.id, { employeeId: employeeEmp, issuedOn: '2026-02-30' })).json().error).toBe('INVALID_DATE');
      expect((await issue(admin, asset.id, { employeeId: separatedEmp })).json().error).toBe('EMPLOYEE_NOT_ACTIVE');
      expect((await issue(admin, asset.id, { employeeId: '00000000-0000-4000-8000-000000000000' })).statusCode).toBe(404);
      // DF02 / C4: an administrator does not record custody of their own items.
      expect((await issue(admin, asset.id, { employeeId: adminEmp })).json().error).toBe('SELF_ACTION_NOT_ALLOWED');
      expect((await issue(admin2, asset.id, { employeeId: adminEmp, issuedOn: addDays(today, -10) })).statusCode).toBe(201);
      expect((await giveBack(admin, asset.id)).json().error).toBe('SELF_ACTION_NOT_ALLOWED');
      expect((await giveBack(admin2, asset.id, { returnedOn: addDays(today, -11) })).json().error).toBe('DATE_BEFORE_ISSUE');
      expect((await giveBack(admin2, asset.id, { returnedOn: addDays(today, -5) })).statusCode).toBe(200);
      // A later issue cannot start before the last return (intervals never overlap).
      expect((await issue(sysAdmin, asset.id, { employeeId: colleagueEmp, issuedOn: addDays(today, -6) })).json().error).toBe('DATE_BEFORE_LAST_RETURN');
      expect((await issue(sysAdmin, asset.id, { employeeId: colleagueEmp, issuedOn: addDays(today, -5) })).statusCode).toBe(201);
    });

    it('an item is never issued to two employees at once, whatever the timing', async () => {
      for (let round = 0; round < 3; round++) {
        const asset = await newAsset();
        const results = await Promise.all([issue(admin, asset.id, { employeeId: employeeEmp }), issue(admin2, asset.id, { employeeId: colleagueEmp })]);
        expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
        expect(results.find((r) => r.statusCode === 409)!.json().error).toBe('ASSET_NOT_AVAILABLE');
        expect(await h.one<{ n: number }>(`select count(*)::int as n from asset_custody where asset_id = $1 and returned_on is null`, [asset.id])).toEqual({ n: 1 });
      }
      // Concurrent acknowledgments record one.
      const asset = await newAsset();
      const custodyId = (await issue(admin, asset.id, { employeeId: employeeEmp })).json().custodyId as string;
      const acks = await Promise.all([acknowledge(employee, custodyId), acknowledge(employee, custodyId)]);
      expect(acks.map((r) => r.statusCode).sort()).toEqual([200, 201]);
      expect(await h.one<{ n: number }>(`select count(*)::int as n from asset_custody_acknowledgment where custody_id = $1`, [custodyId])).toEqual({ n: 1 });
      // A returned item that was never acknowledged cannot be acknowledged afterwards.
      const late = await newAsset();
      const lateCustody = (await issue(admin, late.id, { employeeId: employeeEmp })).json().custodyId as string;
      await giveBack(admin, late.id);
      expect((await acknowledge(employee, lateCustody)).json().error).toBe('CUSTODY_CLOSED');
    });

    it('retires items in stock only; a retired item is final and stays in the register', async () => {
      const asset = await newAsset();
      await issue(admin, asset.id, { employeeId: employeeEmp });
      const issuedVersion = (await h.call(admin, 'GET', `/v1/assets/${asset.id}`)).json().version as number;
      expect((await h.call(admin, 'POST', `/v1/assets/${asset.id}/retire`, { note: 'Synthetic retirement', expectedVersion: issuedVersion })).json().error).toBe('ASSET_ISSUED');
      await giveBack(admin, asset.id);
      const version = (await h.call(admin, 'GET', `/v1/assets/${asset.id}`)).json().version as number;
      expect((await h.call(admin, 'POST', `/v1/assets/${asset.id}/retire`, { note: '   ', expectedVersion: version })).json().error).toBe('NOTE_REQUIRED');
      expect((await h.call(admin, 'POST', `/v1/assets/${asset.id}/retire`, { note: 'x', expectedVersion: version, retiredOn: addDays(today, 1) })).json().error).toBe('DATE_IN_FUTURE');
      const retired = await h.call(admin, 'POST', `/v1/assets/${asset.id}/retire`, { note: 'Beyond repair (synthetic)', expectedVersion: version });
      expect(retired.statusCode, retired.body).toBe(200);
      expect(retired.json()).toMatchObject({ state: 'RETIRED', retiredOn: today, retirementNote: 'Beyond repair (synthetic)' });
      expect((await h.call(admin, 'POST', `/v1/assets/${asset.id}/retire`, { note: 'again', expectedVersion: version + 1 })).json().error).toBe('ASSET_RETIRED');
      expect((await issue(admin, asset.id, { employeeId: employeeEmp })).json().error).toBe('ASSET_RETIRED');
      expect((await h.call(admin, 'PATCH', `/v1/assets/${asset.id}`, { expectedVersion: version + 1, description: 'x' })).json().error).toBe('ASSET_RETIRED');
      expect((await h.call(admin, 'GET', '/v1/assets?state=RETIRED')).json().items.some((x: { id: string }) => x.id === asset.id)).toBe(true);
      // The employee keeps the custody history of a retired item.
      expect((await ownAssets(employee, employeeEmp)).some((c) => c.assetCode === asset.assetCode && c.status === 'RETURNED')).toBe(true);
      expect(await actions('asset', asset.id)).toEqual(['CREATE', 'ISSUE', 'RETURN', 'RETIRE']);
    });

    it('the employee never issues, returns, retires, transfers or writes off an item (FR-110)', async () => {
      const asset = await newAsset();
      const custodyId = (await issue(admin, asset.id, { employeeId: employeeEmp })).json().custodyId as string;
      expect((await issue(employee, asset.id, { employeeId: employeeEmp })).statusCode).toBe(403);
      expect((await giveBack(employee, asset.id)).statusCode).toBe(403);
      expect((await h.call(employee, 'POST', `/v1/assets/${asset.id}/retire`, { note: 'x', expectedVersion: 2 })).statusCode).toBe(403);
      expect((await h.call(employee, 'PATCH', `/v1/assets/${asset.id}`, { expectedVersion: 2, description: 'x' })).statusCode).toBe(403);
      // No transfer or write-off action exists at all (TN16 "no write-off/transfer approval").
      expect((await h.call(employee, 'POST', `/v1/assets/${asset.id}/transfer`, { employeeId: colleagueEmp })).statusCode).toBe(404);
      expect((await h.call(admin, 'POST', `/v1/assets/${asset.id}/write-off`, {})).statusCode).toBe(404);
      expect((await ownAssets(employee, employeeEmp)).find((c) => c.custodyId === custodyId)?.status).toBe('HELD');
      expect((await h.call(admin, 'GET', `/v1/assets/${asset.id}`)).json().holder.employeeId).toBe(employeeEmp);
    });
  });

  describe('custody requests: independent decision, then a separate issue (DF03, C4)', () => {
    it('submits with an idempotency key, notifies the assigned reviewer with operational fields only, and decides', async () => {
      const before = await pending(employee);
      const heldBefore = (await ownAssets(employee, employeeEmp)).length;
      const k = key();
      const asked = await ask(employee, { idempotencyKey: k, itemDescription: 'Synthetic docking station', reason: 'Synthetic hot-desk setup' });
      expect(asked.statusCode, asked.body).toBe(201);
      expect(asked.json()).toMatchObject({ state: 'SUBMITTED', replayed: false });
      const requestId = asked.json().requestId as string;
      const replay = await ask(employee, { idempotencyKey: k, itemDescription: 'Synthetic docking station', reason: 'Synthetic hot-desk setup' });
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual({ requestId, state: 'SUBMITTED', replayed: true });
      expect((await ask(employee, { idempotencyKey: k, reason: 'Something else' })).json().error).toBe('IDEMPOTENCY_KEY_REUSED');
      expect((await ask(employee, { categoryCode: 'NOT_A_CATEGORY' })).json().error).toBe('INVALID_CATEGORY');
      expect(await pending(employee)).toBe((before ?? 0) + 1);
      // Administrative contexts cannot ask on anyone's behalf (BR-055).
      expect((await ask(admin)).statusCode).toBe(403);
      expect((await h.call(employee, 'GET', '/v1/me/asset-categories')).json().items).toEqual(expect.arrayContaining([{ code: 'GENERAL', label: 'General item' }]));

      await dispatchOutbox(h.pool);
      const notice = (await inbox(admin)).find((n) => n.category === 'ASSET_REQUEST_SUBMITTED')!;
      expect(notice.body).toContain('General item');
      expect(notice.body).not.toContain('docking');
      expect(notice.body).not.toContain('hot-desk');
      expect((await inbox(admin2)).some((n) => n.category === 'ASSET_REQUEST_SUBMITTED')).toBe(false);

      const t = (await taskFor(admin, requestId))!;
      expect(t.request).toMatchObject({ id: requestId, employeeId: employeeEmp, category: { code: 'GENERAL' }, itemDescription: 'Synthetic docking station', reason: 'Synthetic hot-desk setup', state: 'SUBMITTED' });
      expect(Array.isArray(t.request!.currentlyHeld)).toBe(true);
      expect(await taskFor(admin2, requestId)).toBeUndefined();
      // Not assigned to admin2, and not decidable by the employee.
      expect((await decide(admin2, t.taskId, { decision: 'APPROVE' })).statusCode).toBe(404);
      expect((await decide(employee, t.taskId, { decision: 'APPROVE' })).statusCode).toBe(403);
      expect((await decide(admin, t.taskId, { decision: 'RETURN', reason: 'x' })).json().error).toBe('RETURN_NOT_ALLOWED');
      expect((await decide(admin, t.taskId, { decision: 'REJECT' })).json().error).toBe('REASON_REQUIRED');
      const decisionKey = key();
      const approved = await decide(admin, t.taskId, { decision: 'APPROVE', reason: 'Synthetic reviewer note', idempotencyKey: decisionKey });
      expect(approved.statusCode, approved.body).toBe(200);
      expect(approved.json()).toEqual({ requestId, state: 'APPROVED', replayed: false });
      expect((await decide(admin, t.taskId, { decision: 'APPROVE', idempotencyKey: decisionKey })).json()).toEqual({ requestId, state: 'APPROVED', replayed: true });
      expect((await decide(admin, t.taskId, { decision: 'APPROVE' })).json().error).toBe('TASK_CLOSED');
      expect(await h.one<{ n: number }>(`select count(*)::int as n from outbox_event where aggregate_id = $1 and topic = 'asset_request.decided'`, [requestId])).toEqual({ n: 1 });
      expect(await pending(employee)).toBe(before ?? 0);

      // Approval issues nothing by itself.
      expect((await ownAssets(employee, employeeEmp)).length).toBe(heldBefore);
      await dispatchOutbox(h.pool);
      expect((await inbox(employee)).find((n) => n.category === 'ASSET_REQUEST_DECIDED')!.body).toBe('Your custody request for General item was approved.');

      // The employee sees the outcome and the decision history, never the reviewer's note.
      const mine = (await myRequests(employee, employeeEmp)).find((r) => r.id === requestId)!;
      expect(mine).toMatchObject({ state: 'APPROVED', pendingWith: null, decisions: [{ decision: 'APPROVE' }], fulfilment: null, reason: 'Synthetic hot-desk setup' });
      expect(JSON.stringify(mine)).not.toContain('Synthetic reviewer note');
      const own = ((await h.call(employee, 'GET', '/v1/me/requests?kind=asset_request')).json().items as Record<string, unknown>[]).find((r) => r.requestId === requestId);
      expect(own).toMatchObject({ kind: 'asset_request', state: 'APPROVED', decisions: [{ step: 1, decision: 'APPROVE' }] });
      expect(JSON.stringify(own)).not.toContain('Synthetic reviewer note');
      expect((await h.call(colleague, 'GET', `/v1/employees/${employeeEmp}/asset-requests`)).statusCode).toBe(404);

      // Fulfilment: an Admin issues an item separately and links it to the approved request, once.
      const open = (await h.call(admin, 'GET', '/v1/asset-requests?unfulfilled=true')).json();
      expect(open.items.some((r: { id: string }) => r.id === requestId)).toBe(true);
      const item = await newAsset({ description: 'Synthetic docking station' });
      expect((await issue(admin, item.id, { employeeId: colleagueEmp, requestId })).json().error).toBe('REQUEST_NOT_APPLICABLE');
      const fulfilled = await issue(admin, item.id, { employeeId: employeeEmp, requestId });
      expect(fulfilled.statusCode, fulfilled.body).toBe(201);
      const spare = await newAsset();
      expect((await issue(admin, spare.id, { employeeId: employeeEmp, requestId })).json().error).toBe('REQUEST_ALREADY_FULFILLED');
      expect((await myRequests(employee, employeeEmp)).find((r) => r.id === requestId)).toMatchObject({ fulfilment: { custodyId: fulfilled.json().custodyId, assetCode: item.assetCode } });
      expect((await ownAssets(employee, employeeEmp)).find((c) => c.custodyId === fulfilled.json().custodyId)).toMatchObject({ requestId, status: 'HELD' });
      expect((await h.call(admin, 'GET', '/v1/asset-requests?unfulfilled=true')).json().items.some((r: { id: string }) => r.id === requestId)).toBe(false);

      // Outbox payloads and notifications carry identifiers and outcomes only.
      const payloads = await h.one<{ t: string }>(`select coalesce(string_agg(payload::text, ' '), '') as t from outbox_event where company_id = $1 and aggregate_id = $2`, [A.id, requestId]);
      expect(payloads.t).not.toContain('hot-desk');
      expect(payloads.t).not.toContain('docking');
      const delivered = await h.one<{ t: string }>(`select coalesce(string_agg(coalesce(title, '') || ' ' || body, ' '), '') as t from notification where company_id = $1`, [A.id]);
      expect(delivered.t).not.toContain('hot-desk');
      expect(delivered.t).not.toContain('Synthetic reviewer note');
      expect(await actions('asset_request', requestId)).toEqual(['CREATE', 'APPROVE']);
      expect(await trail([requestId])).toContain('Synthetic reviewer note'); // the reviewer's reason is in the audit record only
    });

    it('a rejection needs a reason the employee never sees; an issue for a request not approved is refused', async () => {
      const requestId = (await ask(colleague)).json().requestId as string;
      const item = await newAsset();
      expect((await issue(admin, item.id, { employeeId: colleagueEmp, requestId })).json().error).toBe('REQUEST_NOT_APPROVED');
      const t = (await taskFor(admin, requestId))!;
      expect((await decide(admin, t.taskId, { decision: 'REJECT', reason: 'Synthetic private rejection note' })).json().state).toBe('REJECTED');
      const mine = (await myRequests(colleague, colleagueEmp)).find((r) => r.id === requestId)!;
      expect(mine).toMatchObject({ state: 'REJECTED', decisions: [{ decision: 'REJECT' }] });
      expect(JSON.stringify(mine)).not.toContain('Synthetic private rejection note');
      expect((await issue(admin, item.id, { employeeId: colleagueEmp, requestId })).json().error).toBe('REQUEST_NOT_APPROVED');
      await dispatchOutbox(h.pool);
      expect((await inbox(colleague)).find((n) => n.category === 'ASSET_REQUEST_DECIDED')!.body).toBe('Your custody request for General item was rejected.');
    });

    it('the employee may withdraw before the decision; others cannot touch the request', async () => {
      const requestId = (await ask(employee)).json().requestId as string;
      const t = (await taskFor(admin, requestId))!;
      expect((await h.call(colleague, 'POST', `/v1/me/asset-requests/${requestId}/withdraw`)).statusCode).toBe(404);
      expect((await h.call(admin, 'POST', `/v1/me/asset-requests/${requestId}/withdraw`)).statusCode).toBe(403);
      expect((await h.call(employee, 'POST', `/v1/me/asset-requests/${requestId}/withdraw`)).json()).toEqual({ requestId, state: 'WITHDRAWN' });
      expect((await h.call(employee, 'POST', `/v1/me/asset-requests/${requestId}/withdraw`)).json().error).toBe('INVALID_STATE');
      expect((await decide(admin, t.taskId, { decision: 'APPROVE' })).json().error).toBe('TASK_CLOSED');
      expect((await tasks(admin)).some((x) => x.request?.id === requestId)).toBe(false);
      expect(await actions('asset_request', requestId)).toEqual(['CREATE', 'WITHDRAW']);
      // The administrator's refused attempt is recorded, without payload (FR-098).
      const denial = await h.one<{ actor_user_id: string; after_values: Record<string, unknown> }>(
        `select actor_user_id, after_values from audit_event where company_id = $1 and record_key = $2 and action = 'ACCESS_DENIED'`,
        [A.id, requestId],
      );
      expect(denial).toMatchObject({ actor_user_id: admin.user, after_values: { action: 'submit', reason: 'NO_PERMISSION' } });
    });

    it('the requester never decides their own request: it goes to the next independent reviewer (C4)', async () => {
      // The administrator asks from their own Employee context; they are first on the list but never eligible.
      const requestId = (await ask(adminAsEmployee)).json().requestId as string;
      expect(await taskFor(admin, requestId)).toBeUndefined();
      const t = (await taskFor(admin2, requestId))!;
      expect(t).toBeDefined();
      expect((await decide(admin, t.taskId, { decision: 'APPROVE' })).statusCode).toBe(404);
      expect((await decide(admin2, t.taskId, { decision: 'APPROVE' })).json().state).toBe('APPROVED');
      // With nobody else eligible, submission is refused with a repairable routing error, never auto-approved.
      expect((await h.call(admin, 'PUT', '/v1/workflows/asset_request/fallback-reviewers', { reviewers: [{ userId: admin.user, priority: 1 }] })).statusCode).toBe(200);
      try {
        expect((await ask(adminAsEmployee)).json().error).toBe('NO_ELIGIBLE_REVIEWER');
      } finally {
        await h.call(admin, 'PUT', '/v1/workflows/asset_request/fallback-reviewers', {
          reviewers: [
            { userId: admin.user, priority: 1 },
            { userId: admin2.user, priority: 2 },
          ],
        });
      }
    });

    it('concurrent replays and a decision racing a withdrawal apply once', async () => {
      // The same submission sent twice at once creates one request.
      const k = key();
      const both = await Promise.all([ask(colleague, { idempotencyKey: k }), ask(colleague, { idempotencyKey: k })]);
      expect(both.map((r) => r.statusCode).sort()).toEqual([200, 201]);
      expect(new Set(both.map((r) => r.json().requestId)).size).toBe(1);
      expect(await h.one<{ n: number }>(`select count(*)::int as n from asset_request where submit_key = $1`, [k])).toEqual({ n: 1 });
      // A decision and a withdrawal at the same moment: exactly one of them takes effect.
      for (let round = 0; round < 3; round++) {
        const requestId = (await ask(colleague)).json().requestId as string;
        const t = (await taskFor(admin, requestId))!;
        const [decided, withdrawn] = await Promise.all([
          decide(admin, t.taskId, { decision: 'APPROVE' }),
          h.call(colleague, 'POST', `/v1/me/asset-requests/${requestId}/withdraw`),
        ]);
        const state = (await h.one<{ state: string }>(`select state from asset_request where id = $1`, [requestId])).state;
        if (state === 'APPROVED') {
          expect(decided.statusCode).toBe(200);
          expect(withdrawn.json().error).toBe('INVALID_STATE');
        } else {
          expect(state).toBe('WITHDRAWN');
          expect(withdrawn.statusCode).toBe(200);
          expect(decided.json().error).toBe('TASK_CLOSED');
        }
        expect((await h.one<{ state: string }>(`select bt.state from asset_request r join business_transaction bt on bt.id = r.transaction_id where r.id = $1`, [requestId])).state).toBe(state);
      }
      // The same issue sent twice at once records one custody.
      const asset = await newAsset();
      const issueKey = key();
      const issues = await Promise.all([issue(admin, asset.id, { employeeId: colleagueEmp, idempotencyKey: issueKey }), issue(admin, asset.id, { employeeId: colleagueEmp, idempotencyKey: issueKey })]);
      expect(issues.map((r) => r.statusCode).sort()).toEqual([200, 201]);
      expect(issues.find((r) => r.statusCode === 200)!.json().replayed).toBe(true);
      expect(await h.one<{ n: number }>(`select count(*)::int as n from asset_custody where asset_id = $1`, [asset.id])).toEqual({ n: 1 });
    });

    it('another kind of task is not decided on this route', async () => {
      expect((await h.call(admin, 'PUT', '/v1/workflows/profile_change/fallback-reviewers', { reviewers: [{ userId: admin.user, priority: 1 }] })).statusCode).toBe(200);
      const asked = await h.call(colleague, 'POST', '/v1/me/profile-changes', { displayName: 'Cal Renamed (synthetic)' });
      expect(asked.statusCode, asked.body).toBe(201);
      const profileTask = ((await h.call(admin, 'GET', '/v1/profile-changes/tasks/mine')).json().items as { taskId: string; request: { id: string } }[]).find(
        (x) => x.request.id === asked.json().requestId,
      )!;
      expect((await decide(admin, profileTask.taskId, { decision: 'APPROVE' })).statusCode).toBe(404);
      expect((await h.one<{ state: string }>(`select state from profile_change_request where id = $1`, [asked.json().requestId])).state).toBe('SUBMITTED');
    });

    it('request lists and the review queue follow row scope; held items need the custody read duty in the same assignment (C1)', async () => {
      // A requester outside the department-filtered reviewer's scope (the synthetic second department).
      const outsiderEmp = await person({ name: 'Otto Outsider (synthetic)', departmentId: A.financeDept });
      const outsider = await h.actor(A, 'EMPLOYEE', { employeeId: outsiderEmp });
      const reviewerOnly = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['asset_request.read.operational', 'asset_request.decide.operational'] });
      const route = (reviewers: TestActor[]) =>
        h.call(admin, 'PUT', '/v1/workflows/asset_request/fallback-reviewers', { reviewers: reviewers.map((r, i) => ({ userId: r.user, priority: i + 1 })) });
      const ids = async (a: TestActor) => ((await h.call(a, 'GET', '/v1/asset-requests?state=SUBMITTED&pageSize=100')).json().items as { id: string }[]).map((r) => r.id);
      try {
        // DF03: a reviewer is chosen only within their row scope. With nobody on the list able to open the outsider's
        // request, submission is refused as a repairable routing error and nothing is created (I-25).
        expect((await route([filteredAdmin])).statusCode).toBe(200);
        const refused = await ask(outsider);
        expect(refused.statusCode).toBe(422);
        expect(refused.json().error).toBe('NO_ELIGIBLE_REVIEWER');
        expect(await h.one<{ n: number }>(`select count(*)::int as n from asset_request where company_id = $1 and employee_id = $2`, [A.id, outsiderEmp])).toEqual({ n: 0 });
        // With an unrestricted reviewer next on the list, the outsider's request goes to them; the in-scope one to the filtered reviewer.
        expect((await route([filteredAdmin, admin])).statusCode).toBe(200);
        const outside = (await ask(outsider)).json().requestId as string;
        const inside = (await ask(employee)).json().requestId as string;
        // The Employee OWN context lists its own requests only; a filtered reviewer its scope; another company nothing.
        expect(await ids(employee)).toContain(inside);
        expect(await ids(employee)).not.toContain(outside);
        expect(await ids(outsider)).toEqual([outside]);
        expect(await ids(filteredAdmin)).toContain(inside);
        expect(await ids(filteredAdmin)).not.toContain(outside);
        expect(await ids(admin)).toEqual(expect.arrayContaining([inside, outside]));
        expect((await ids(bAdmin)).some((x) => x === inside || x === outside)).toBe(false);
        expect((await h.call(filteredAdmin, 'GET', `/v1/employees/${outsiderEmp}/asset-requests`)).statusCode).toBe(404);
        const denial = await h.one<{ after_values: { reason: string } }>(
          `select after_values from audit_event where company_id = $1 and actor_user_id = $2 and record_key = $3 and action = 'ACCESS_DENIED'`,
          [A.id, filteredAdmin.user, outsiderEmp],
        );
        expect(denial.after_values.reason).toBe('OUT_OF_SCOPE');
        // The outsider's task went to the reviewer who can open it, never to the filtered one; the inside one to the filtered reviewer.
        const tasksFor = async (a: TestActor, requestId: string) => {
          const transactionId = (await h.one<{ transaction_id: string }>(`select transaction_id from asset_request where id = $1`, [requestId])).transaction_id;
          return ((await h.call(a, 'GET', '/v1/asset-requests/tasks/mine')).json().items as { transactionId: string }[]).filter((x) => x.transactionId === transactionId);
        };
        expect(await tasksFor(filteredAdmin, outside)).toEqual([]);
        expect(await tasksFor(admin, outside)).toHaveLength(1);
        expect(await tasksFor(filteredAdmin, inside)).toHaveLength(1);

        // The requester's current items appear in the queue only for a reviewer who may also read custody.
        const held = await newAsset();
        expect((await issue(admin, held.id, { employeeId: colleagueEmp })).statusCode).toBe(201);
        expect((await route([reviewerOnly])).statusCode).toBe(200);
        const first = (await ask(colleague)).json().requestId as string;
        const blind = (await taskFor(reviewerOnly, first))!;
        expect(blind.request).toMatchObject({ id: first, employeeId: colleagueEmp });
        expect(blind.request).not.toHaveProperty('currentlyHeld');
        expect((await route([admin])).statusCode).toBe(200);
        const second = (await ask(colleague)).json().requestId as string;
        expect((await taskFor(admin, second))!.request!.currentlyHeld).toEqual(expect.arrayContaining([expect.objectContaining({ assetCode: held.assetCode })]));
        for (const [a, requestId] of [
          [outsider, outside],
          [employee, inside],
          [colleague, first],
          [colleague, second],
        ] as const) {
          expect((await h.call(a, 'POST', `/v1/me/asset-requests/${requestId}/withdraw`)).statusCode).toBe(200);
        }
      } finally {
        await route([admin, admin2]);
      }
    });
  });

  describe('My ESS TN16 and exit clearance', () => {
    it('TN16 is available in the Employee OWN context with own-record links', async () => {
      const tab = ((await h.call(employee, 'GET', '/v1/me/ess')).json().tabs as { id: string; status: string; links: { rel: string; method: string; href: string }[] }[]).find(
        (x) => x.id === 'TN16',
      )!;
      expect(tab.status).toBe('AVAILABLE');
      expect(tab.links.map((l) => l.rel)).toEqual(['assets', 'acknowledge', 'requests', 'categories', 'submitRequest', 'decisionHistory']);
      expect(tab.links.find((l) => l.rel === 'assets')!.href).toBe(`/v1/employees/${employeeEmp}/assets`);
      for (const l of tab.links) expect(l.href).toMatch(/^\/v1\/(me\/|employees\/[0-9a-f-]{36}\/)/);
      // Every link works for the employee.
      for (const l of tab.links.filter((x) => x.method === 'GET')) expect((await h.call(employee, 'GET', l.href)).statusCode, l.href).toBe(200);
    });

    it('lists the items an employee still holds for clearance, and nothing once returned', async () => {
      const leaver = await person({ name: 'Lee Leaver (synthetic)' });
      const one = await newAsset({ identifier: '0007' });
      const two = await newAsset();
      await issue(admin, one.id, { employeeId: leaver });
      await issue(admin, two.id, { employeeId: leaver });
      const held = await assetsStillHeld(h.pool, A.id, leaver);
      expect(held.map((x) => x.assetCode).sort()).toEqual([one.assetCode, two.assetCode].sort());
      expect(held.find((x) => x.assetCode === one.assetCode)).toMatchObject({ assetId: one.id, categoryCode: 'GENERAL', identifier: '0007', issuedOn: today, acknowledgedAt: null });
      const heldList = (await h.call(admin, 'GET', `/v1/employees/${leaver}/assets?status=HELD`)).json();
      expect(heldList.items).toHaveLength(2);
      expect(heldList.employee).toMatchObject({ id: leaver });
      expect(typeof heldList.employee.employeeCode).toBe('string');
      // Returns are recorded even after the employee has separated (clearance).
      await h.setStatus(A, leaver, 'INACTIVE_SEPARATED');
      await giveBack(admin, one.id);
      await giveBack(admin, two.id);
      expect(await assetsStillHeld(h.pool, A.id, leaver)).toEqual([]);
      expect((await h.call(admin, 'GET', `/v1/employees/${leaver}/assets?status=RETURNED`)).json().items).toHaveLength(2);
      // Tenancy: another company's id reads nothing.
      expect(await assetsStillHeld(h.pool, B.id, leaver)).toEqual([]);

      // A clearance gate reading "nothing held" with the lock: an issue to that employee waits until the gate ends.
      const gateEmp = await person({ name: 'Gil Gate (synthetic)' });
      const gated = await newAsset();
      const client = await h.pool.connect();
      try {
        await client.query('begin');
        expect(await assetsStillHeld(client, A.id, gateEmp, { lock: true })).toEqual([]);
        const waiting = issue(admin, gated.id, { employeeId: gateEmp });
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(await h.one<{ n: number }>(`select count(*)::int as n from asset_custody where asset_id = $1`, [gated.id])).toEqual({ n: 0 });
        await client.query('commit');
        expect((await waiting).statusCode).toBe(201);
      } finally {
        client.release();
      }
      expect((await assetsStillHeld(h.pool, A.id, gateEmp)).map((x) => x.assetId)).toEqual([gated.id]);
    });

    it('an issue that waited on a clearance gate reads the status the gate left: an employee separated meanwhile is issued nothing', async () => {
      const leaving = await person({ name: 'Sam Separating (synthetic)' });
      const item = await newAsset();
      const client = await h.pool.connect();
      let waiting: ReturnType<typeof issue> | undefined;
      try {
        await client.query('begin');
        // The exit flow: nothing held (read under the custody lock), then the employment ends in the same transaction.
        expect(await assetsStillHeld(client, A.id, leaving, { lock: true })).toEqual([]);
        await client.query(
          `update employee set status_id = (select id from reference_value where company_id = $1 and category = 'EMPLOYEE_STATUS' and code = 'INACTIVE_SEPARATED')
            where company_id = $1 and id = $2`,
          [A.id, leaving],
        );
        // The issue starts while the gate is open, with the employee still active as far as it can read.
        waiting = issue(admin, item.id, { employeeId: leaving });
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(await h.one<{ n: number }>(`select count(*)::int as n from asset_custody where asset_id = $1`, [item.id])).toEqual({ n: 0 });
        await client.query('commit');
      } catch (err) {
        await client.query('rollback');
        throw err;
      } finally {
        client.release();
      }
      const res = await waiting!;
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json().error).toBe('EMPLOYEE_NOT_ACTIVE');
      expect(await assetsStillHeld(h.pool, A.id, leaving)).toEqual([]);
      expect((await h.one<{ state: string }>(`select state from asset where id = $1`, [item.id])).state).toBe('IN_STOCK');
    });
  });

  describe('database invariants (direct writes)', () => {
    it('one open custody per item, matching register state, immutable history, no deletion', async () => {
      const asset = await newAsset();
      const custodyId = (await issue(admin, asset.id, { employeeId: employeeEmp })).json().custodyId as string;
      const insertOpen = (employeeId: string) =>
        h.db.query(
          `insert into asset_custody (company_id, asset_id, employee_id, issued_on, issue_condition, issue_key, created_by) values ($1, $2, $3, $4, 'x', $5, $6)`,
          [A.id, asset.id, employeeId, today, key(), admin.user],
        );
      await expect(insertOpen(colleagueEmp)).rejects.toMatchObject({ code: expect.stringMatching(/^(23505|23P01)$/) });
      // The register and the history must agree at commit.
      const stock = await newAsset();
      await h.db.query('begin');
      await h.db.query(`update asset set state = 'ISSUED' where id = $1`, [stock.id]);
      await expectSqlError(h.db.query('commit'), CHECK_VIOLATION);
      expect((await h.one<{ state: string }>(`select state from asset where id = $1`, [stock.id])).state).toBe('IN_STOCK');
      await expectSqlError(h.db.query(`update asset_custody set employee_id = $2 where id = $1`, [custodyId, colleagueEmp]), CHECK_VIOLATION);
      await expectSqlError(h.db.query(`update asset_custody set issued_on = issued_on - 1 where id = $1`, [custodyId]), CHECK_VIOLATION);
      await expectSqlError(h.db.query(`delete from asset_custody where id = $1`, [custodyId]), CHECK_VIOLATION);
      await expectSqlError(h.db.query(`delete from asset where id = $1`, [asset.id]), CHECK_VIOLATION);
      await expectSqlError(h.db.query(`update asset set asset_code = 'RENAMED-1' where id = $1`, [asset.id]), CHECK_VIOLATION);
      // Only the holding employee acknowledges; an acknowledgment is never changed.
      await expectSqlError(
        h.db.query(`insert into asset_custody_acknowledgment (company_id, custody_id, employee_id, acknowledged_by) values ($1, $2, $3, $4)`, [A.id, custodyId, employeeEmp, colleague.user]),
        CHECK_VIOLATION,
      );
      await acknowledge(employee, custodyId);
      await expectSqlError(h.db.query(`update asset_custody_acknowledgment set acknowledged_at = now() where custody_id = $1`, [custodyId]), CHECK_VIOLATION);
      await expectSqlError(h.db.query(`delete from asset_custody_acknowledgment where custody_id = $1`, [custodyId]), CHECK_VIOLATION);
      // A returned record is final.
      await giveBack(admin, asset.id);
      await expectSqlError(h.db.query(`update asset_custody set return_condition = 'rewritten' where id = $1`, [custodyId]), CHECK_VIOLATION);
      // A retired item cannot come back.
      const old = await newAsset();
      await h.call(admin, 'POST', `/v1/assets/${old.id}/retire`, { note: 'Synthetic', expectedVersion: 1 });
      await expectSqlError(h.db.query(`update asset set state = 'IN_STOCK', retired_on = null, retirement_note = null where id = $1`, [old.id]), CHECK_VIOLATION);
      // A request's state mirrors its transaction, and a submitted request is immutable.
      const requestId = (await ask(colleague)).json().requestId as string;
      await expectSqlError(h.db.query(`update asset_request set reason = 'rewritten' where id = $1`, [requestId]), CHECK_VIOLATION);
      await h.db.query('begin');
      await h.db.query(`update asset_request set state = 'APPROVED', decided_at = now() where id = $1`, [requestId]);
      await expectSqlError(h.db.query('commit'), CHECK_VIOLATION);
    });
  });
});
