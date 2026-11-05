// An employee update re-checks authority inside its transaction, after the record's lock (docs/09 §6.5; C1 "Every data
// request ... must fail"; C4 "Role revocation during session"): a grant revoked after the route guard saw it changes nothing.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';

let h: Harness;
let A: Company;
let hr: TestActor;

/**
 * Fires a request that passes the route guard and then, inside its transaction, waits for the assignment row this helper
 * holds (reassertAccess share-locks it). `revoke` commits meanwhile, so only that check can refuse the request.
 */
async function narrowedAfterGuard(a: TestActor, revoke: () => Promise<unknown>, fire: () => ReturnType<typeof h.call>) {
  await h.db.query('begin');
  let pending: ReturnType<typeof h.call> | undefined;
  try {
    await h.db.query(`select 1 from role_assignment where company_id = $1 and id = $2 for update`, [A.id, a.assignment]);
    pending = fire();
    let blocked = false;
    for (let i = 0; i < 400 && !blocked; i++) {
      const waiting = await h.pool.query(`select 1 from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`);
      blocked = (waiting.rowCount ?? 0) > 0;
      if (!blocked) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(blocked).toBe(true);
    await revoke();
  } finally {
    await h.db.query('commit');
  }
  return pending!;
}

const allowlistOff = (a: TestActor, permission?: { action: string; fieldGroup: string }) =>
  h.db.query(
    `update role_assignment_permission rap set active = false from permission p
      where rap.company_id = $1 and rap.role_assignment_id = $2 and p.id = rap.permission_id and ($3::text is null or (p.action = $3 and p.field_group = $4))`,
    [A.id, a.assignment, permission?.action ?? null, permission?.fieldGroup ?? null],
  );

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['employee.create.personal', 'employee.read.personal', 'employee.update.personal'] });
});

afterAll(async () => {
  await h?.stop();
});

const newEmployee = async () => {
  const res = await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A));
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; version: number; displayName: string };
};

describe('updateEmployee re-checks access in its transaction', () => {
  it('a grant revoked after the route guard writes nothing, audits nothing and raises no event', async () => {
    const editor = await h.actor(A, 'HR_ADMINISTRATOR');
    const e = await newEmployee();
    const res = await narrowedAfterGuard(
      editor,
      () => allowlistOff(editor),
      () => h.call(editor, 'PATCH', `/v1/employees/${e.id}`, { expectedVersion: e.version, displayName: 'Renamed after revocation' }),
    );
    expect(res.statusCode, res.body).toBe(403);
    const row = await h.one<{ display_name: string; version: number }>(`select display_name, version from employee where company_id = $1 and id = $2`, [A.id, e.id]);
    expect(row).toEqual({ display_name: e.displayName, version: e.version });
    const audit = await h.db.query(`select 1 from audit_event where company_id = $1 and resource_code = 'employee' and record_key = $2 and action = 'UPDATE'`, [A.id, e.id]);
    expect(audit.rowCount).toBe(0);
    const events = await h.db.query(`select 1 from outbox_event where company_id = $1 and topic = 'employee.updated' and aggregate_id = $2`, [A.id, e.id]);
    expect(events.rowCount).toBe(0);
  });

  it('checks the field group the change writes: losing only the personal group refuses a personal change, not an operational one', async () => {
    const editor = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['employee.update.personal'] });
    const e = await newEmployee();
    const refused = await narrowedAfterGuard(
      editor,
      () => allowlistOff(editor, { action: 'update', fieldGroup: 'personal' }),
      () => h.call(editor, 'PATCH', `/v1/employees/${e.id}`, { expectedVersion: e.version, dateOfBirth: '1990-01-15' }),
    );
    expect(refused.statusCode, refused.body).toBe(403);
    const row = await h.one<{ date_of_birth: string | null; version: number }>(`select date_of_birth, version from employee where company_id = $1 and id = $2`, [A.id, e.id]);
    expect(row).toEqual({ date_of_birth: null, version: e.version });

    const allowed = await h.call(editor, 'PATCH', `/v1/employees/${e.id}`, { expectedVersion: e.version, displayName: 'Synthetic Renamed' });
    expect(allowed.statusCode, allowed.body).toBe(200);
  });

  it('with the grant intact the update goes through', async () => {
    const e = await newEmployee();
    const res = await h.call(hr, 'PATCH', `/v1/employees/${e.id}`, { expectedVersion: e.version, displayName: 'Synthetic Kept', dateOfBirth: '1991-02-03' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ displayName: 'Synthetic Kept', dateOfBirth: '1991-02-03' });
  });
});
