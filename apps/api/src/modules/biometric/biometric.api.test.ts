// Biometric API ingestion (FR-086/087/088; BR-035/036/037; DF09; DF13; CI19; ZT24). A fake provider stands in
// for real devices; no external service is contacted. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { devTokenVerifier } from '../../auth/tokens.js';
import { newScope, runInScope } from '../../db/budget.js';
import { instrumentDatabase } from '../../db/instrument.js';
import { ASSIGNMENT_HEADER, COMPANY_HEADER } from '../../http/context.js';
import type { PermissionKey } from '../access/baseline.js';
import { type Company, type Harness, startHarness, type TestActor, tokenConfig } from '../../test/harness.js';
import { type BiometricProvider, runSync } from './sync.js';

let h: Harness;
let A: Company;
let B: Company;
let admin: TestActor;
let admin2: TestActor;
let hr: TestActor;
let e1: { id: string; code: string };
let e2: { id: string; code: string };

const BIOMETRIC: PermissionKey[] = [
  'biometric.profile_manage.operational',
  'biometric.mapping_manage.operational',
  'biometric.employee_link_manage.operational',
  'biometric.sync_run.operational',
  'biometric.sync_exception_reprocess.operational',
];

/** Pages addressed by cursor: null -> page 0, 'p1' -> page 1, ...; optional failing page index. */
class FakeProvider implements BiometricProvider {
  calls = 0;
  constructor(
    private pages: unknown[][],
    public failPage: number | null = null,
  ) {}
  async fetchPage({ cursor }: { cursor: string | null }) {
    this.calls++;
    const index = cursor ? Number(cursor.slice(1)) : 0;
    if (index === this.failPage) throw new Error('provider unavailable');
    return { records: this.pages[index] ?? [], nextCursor: index + 1 < this.pages.length ? `p${index + 1}` : null };
  }
}

// Provider "A": nested JSON with an event id and coded direction.
const aRecord = (emp: string, ts: string, dir: string, id: string) => ({ emp: { code: emp }, ts, dir, id });
const A_FIELDS = [
  { sourcePath: 'emp.code', targetField: 'EMPLOYEE_KEY', transformCode: 'TRIM', required: true },
  { sourcePath: 'ts', targetField: 'PUNCH_INSTANT', transformCode: 'PARSE_INSTANT', required: true },
  { sourcePath: 'dir', targetField: 'DIRECTION', transformCode: 'ENUM_MAP', enumConfig: { '0': 'IN', '1': 'OUT' }, required: true },
  { sourcePath: 'id', targetField: 'EVENT_KEY', transformCode: 'IDENTITY', required: true },
];

async function setupProfile(code: string, fields: object[], opts: { dedupeStrategy: string; timestampRule: string; timezone?: string }) {
  const p = (
    await h.call(admin, 'POST', '/v1/biometric/profiles', {
      code,
      name: `${code} devices`,
      requestConfigReference: `secret-store://biometric/${code}/request`,
      authReference: `secret-store://biometric/${code}/credential`,
      providerTimezone: opts.timezone ?? 'Asia/Kolkata',
      paginationMode: 'CURSOR',
      scheduleReference: 'every-15-minutes',
      lookbackMinutes: 10080,
    })
  ).json();
  const m = await h.call(admin, 'POST', `/v1/biometric/profiles/${p.id}/mappings`, { dedupeStrategy: opts.dedupeStrategy, timestampRule: opts.timestampRule, effectiveFrom: '2026-01-01T00:00:00Z', fields });
  expect(m.statusCode).toBe(201);
  return { profileId: p.id as string, mappingId: m.json().mappingRevisionId as string };
}

const sync = (profileId: string, provider: BiometricProvider, windowStart = '2026-03-02T00:00:00Z', windowEnd = '2026-03-03T00:00:00Z') =>
  runSync(h.pool, { companyId: A.id, profileId, actorUserId: admin.user, windowStart: new Date(windowStart), windowEnd: new Date(windowEnd) }, provider, [0, 0]);

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  B = await h.makeCompany();
  admin = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { extra: BIOMETRIC });
  admin2 = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { extra: BIOMETRIC });
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  const make = async () => {
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
    return { id: e.id as string, code: e.employeeCode as string };
  };
  e1 = await make();
  e2 = await make();
});

afterAll(async () => {
  await h?.stop();
});

describe('configuration (FR-086, DF13)', () => {
  it('rejects incomplete mappings and executable-looking paths; never returns credential references', async () => {
    const p = (
      await h.call(admin, 'POST', '/v1/biometric/profiles', {
        code: 'CHECK',
        name: 'Check',
        requestConfigReference: 'secret-store://x/request',
        authReference: 'secret-store://x/credential',
        providerTimezone: 'Asia/Kolkata',
        paginationMode: 'CURSOR',
        scheduleReference: 'every-15-minutes',
        lookbackMinutes: 60,
      })
    ).json();
    const missing = await h.call(admin, 'POST', `/v1/biometric/profiles/${p.id}/mappings`, {
      dedupeStrategy: 'PROVIDER_EVENT_KEY',
      timestampRule: 'ISO_WITH_OFFSET',
      effectiveFrom: '2026-01-01T00:00:00Z',
      fields: A_FIELDS.filter((f) => f.targetField !== 'EMPLOYEE_KEY'),
    });
    expect(missing.json()).toMatchObject({ error: 'MAPPING_INVALID', details: { errors: ['EMPLOYEE_KEY_REQUIRED'] } });
    const injected = await h.call(admin, 'POST', `/v1/biometric/profiles/${p.id}/mappings`, {
      dedupeStrategy: 'PROVIDER_EVENT_KEY',
      timestampRule: 'ISO_WITH_OFFSET',
      effectiveFrom: '2026-01-01T00:00:00Z',
      fields: [{ ...A_FIELDS[0], sourcePath: 'emp.code); drop table employee; --' }, ...A_FIELDS.slice(1)],
    });
    expect(injected.json().details.errors).toContain('INVALID_PATH:EMPLOYEE_KEY');

    expect((await h.call(admin, 'POST', `/v1/biometric/profiles/${p.id}/activate`)).json().error).toBe('MAPPING_NOT_APPROVED');
    const listed = JSON.stringify((await h.call(admin, 'GET', '/v1/biometric/profiles')).json());
    expect(listed).not.toContain('secret-store');
    expect(listed).toContain('"credentialConfigured":true');

    const plainAdmin = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
    expect((await h.call(plainAdmin, 'GET', '/v1/biometric/profiles')).statusCode).toBe(403); // no implicit API authority
  });

  it('two different provider schemas map to the same canonical fields (safe preview applies nothing)', async () => {
    const a = await setupProfile('ALPHA', A_FIELDS, { dedupeStrategy: 'PROVIDER_EVENT_KEY', timestampRule: 'ISO_WITH_OFFSET' });
    const b = await setupProfile(
      'BETA',
      [
        { sourcePath: 'userId', targetField: 'EMPLOYEE_KEY', transformCode: 'UPPER', required: true },
        { sourcePath: 'time', targetField: 'PUNCH_INSTANT', transformCode: 'PARSE_INSTANT', required: true },
        { sourcePath: 'type', targetField: 'DIRECTION', transformCode: 'UPPER', required: true },
      ],
      { dedupeStrategy: 'FINGERPRINT', timestampRule: 'LOCAL_IN_PROVIDER_ZONE' },
    );
    const before = Number((await h.one<{ n: string }>(`select count(*) as n from attendance_punch where company_id = $1`, [A.id])).n);
    const pa = (await h.call(admin, 'POST', `/v1/biometric/mappings/${a.mappingId}/preview`, { records: [aRecord(' E-1 ', '2026-03-02T09:00:00+05:30', '0', 'x1')] })).json();
    const pb = (await h.call(admin, 'POST', `/v1/biometric/mappings/${b.mappingId}/preview`, { records: [{ userId: 'e-1', time: '2026-03-02 09:00:00', type: 'in' }] })).json();
    expect(pa.results[0]).toMatchObject({ ok: true, value: { employeeKey: 'E-1', direction: 'IN', instant: { kind: 'ISO', value: '2026-03-02T03:30:00.000Z' } } });
    expect(pb.results[0]).toMatchObject({ ok: true, value: { employeeKey: 'E-1', direction: 'IN', instant: { kind: 'LOCAL', value: '2026-03-02 09:00:00' } } });
    expect(Number((await h.one<{ n: string }>(`select count(*) as n from attendance_punch where company_id = $1`, [A.id])).n)).toBe(before);
  });
});

describe('fetch, replay and quarantine (FR-087, BR-036, BR-037, ZT24)', () => {
  let profileId: string;

  beforeAll(async () => {
    const p = await setupProfile('GAMMA', A_FIELDS, { dedupeStrategy: 'PROVIDER_EVENT_KEY', timestampRule: 'ISO_WITH_OFFSET' });
    profileId = p.profileId;
    expect((await h.call(admin, 'POST', `/v1/biometric/mappings/${p.mappingId}/approve`)).statusCode).toBe(403); // author
    expect((await h.call(admin2, 'POST', `/v1/biometric/mappings/${p.mappingId}/approve`)).statusCode).toBe(200);
    expect((await h.call(admin, 'POST', `/v1/biometric/profiles/${profileId}/activate`)).statusCode).toBe(200);
    for (const [key, e] of [['DEV-1', e1], ['DEV-2', e2]] as const) {
      await h.call(admin, 'POST', `/v1/biometric/profiles/${profileId}/links`, { externalEmployeeKey: key, employeeId: e.id, effectiveFrom: '2026-01-01T00:00:00Z' });
    }
  });

  it('fetches every page, accepts valid events, and reconciles counts', async () => {
    const provider = new FakeProvider([
      [aRecord('DEV-1', '2026-03-02T09:00:00+05:30', '0', 'g1'), aRecord('DEV-1', '2026-03-02T18:00:00+05:30', '1', 'g2')],
      [aRecord('DEV-2', '2026-03-02T09:05:00+05:30', '0', 'g3'), aRecord('UNKNOWN-9', '2026-03-02T09:05:00+05:30', '0', 'g4')],
      [aRecord('DEV-2', 'not-a-time', '1', 'g5'), aRecord('DEV-2', '2026-03-02T18:00:00+05:30', '7', 'g6')],
    ]);
    const run = await sync(profileId, provider);
    expect(provider.calls).toBe(3);
    expect(run).toMatchObject({ state: 'COMPLETED', pagesCommitted: 3, observations: 6, accepted: 3, duplicates: 0, quarantined: 1, rejected: 2 });
    const punches = await h.db.query(`select employee_id from attendance_punch where biometric_profile_id = $1`, [profileId]);
    expect(punches.rowCount).toBe(3);
  });

  it('replaying an overlapping window adds no punch; same key with different content is quarantined, not overwritten', async () => {
    const run = await sync(
      profileId,
      new FakeProvider([[aRecord('DEV-1', '2026-03-02T09:00:00+05:30', '0', 'g1'), aRecord('DEV-1', '2026-03-02T18:30:00+05:30', '1', 'g2')]]),
    );
    expect(run).toMatchObject({ state: 'COMPLETED', accepted: 0, duplicates: 1, quarantined: 1 });
    const g2 = await h.one<{ occurred_at: Date }>(`select occurred_at from attendance_punch where biometric_profile_id = $1 and external_event_key = 'g2'`, [profileId]);
    expect(g2.occurred_at.toISOString()).toBe('2026-03-02T12:30:00.000Z'); // original 18:00 IST kept
    const conflict = await h.one<{ failure_code: string }>(
      `select o.failure_code from biometric_run_observation o join biometric_sync_run r on r.id = o.run_id
        where r.profile_id = $1 and o.outcome = 'QUARANTINED' order by o.created_at desc limit 1`,
      [profileId],
    );
    expect(conflict.failure_code).toBe('CONFLICTING_PAYLOAD');
  });

  it('a quarantined unknown employee is accepted after an employee link is added and reprocessed', async () => {
    const event = await h.one<{ id: string }>(`select id from biometric_ingest_event where profile_id = $1 and source_event_key = 'g4'`, [profileId]);
    expect((await h.call(admin, 'POST', `/v1/biometric/events/${event.id}/reprocess`)).json().error).toBe('STILL_UNMATCHED');
    const e3 = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    await h.call(admin, 'POST', `/v1/biometric/profiles/${profileId}/links`, { externalEmployeeKey: 'UNKNOWN-9', employeeId: e3.id, effectiveFrom: '2026-01-01T00:00:00Z' });
    expect((await h.call(admin, 'POST', `/v1/biometric/events/${event.id}/reprocess`)).json()).toMatchObject({ state: 'ACCEPTED' });
    expect((await h.call(admin, 'POST', `/v1/biometric/events/${event.id}/reprocess`)).statusCode).toBe(409);
  });

  it('a later page failure keeps the last committed checkpoint; a retry fills the gap without duplicates', async () => {
    const pages = [[aRecord('DEV-1', '2026-03-03T09:00:00+05:30', '0', 'h1')], [aRecord('DEV-1', '2026-03-03T18:00:00+05:30', '1', 'h2')]];
    const failing = await sync(profileId, new FakeProvider(pages, 1));
    expect(failing).toMatchObject({ state: 'PARTIAL', pagesCommitted: 1, committedCheckpoint: 'p1', failureCode: 'FETCH_FAILED', accepted: 1 });
    const retry = await sync(profileId, new FakeProvider(pages));
    expect(retry).toMatchObject({ state: 'COMPLETED', accepted: 1, duplicates: 1 });
    expect((await h.db.query(`select 1 from attendance_punch where biometric_profile_id = $1 and external_event_key in ('h1', 'h2')`, [profileId])).rowCount).toBe(2);
  });

  it('only one run per profile at a time', async () => {
    const mapping = await h.one<{ id: string }>(`select id from biometric_mapping_revision where profile_id = $1`, [profileId]);
    await h.db.query(
      `insert into biometric_sync_run (company_id, profile_id, mapping_revision_id, window_start, window_end, state) values ($1, $2, $3, now() - interval '1 hour', now(), 'RUNNING')`,
      [A.id, profileId, mapping.id],
    );
    await expect(sync(profileId, new FakeProvider([[]]))).rejects.toMatchObject({ statusCode: 409, code: 'RUN_IN_PROGRESS' });
    await h.db.query(`update biometric_sync_run set state = 'FAILED', failure_code = 'TEST', finished_at = now() where profile_id = $1 and state = 'RUNNING'`, [profileId]);
  });

  it('cross-company employee links and overlapping links are refused', async () => {
    const hrB = await h.actor(B, 'HR_ADMINISTRATOR');
    const other = (await h.call(hrB, 'POST', '/v1/employees', h.newEmployeeBody(B))).json();
    expect((await h.call(admin, 'POST', `/v1/biometric/profiles/${profileId}/links`, { externalEmployeeKey: 'X-1', employeeId: other.id, effectiveFrom: '2026-01-01T00:00:00Z' })).statusCode).toBe(422);
    expect((await h.call(admin, 'POST', `/v1/biometric/profiles/${profileId}/links`, { externalEmployeeKey: 'DEV-1', employeeId: e2.id, effectiveFrom: '2026-02-01T00:00:00Z' })).statusCode).toBe(409);
  });

  it('runs need a configured provider adapter (DF13)', async () => {
    const res = await h.call(admin, 'POST', `/v1/biometric/profiles/${profileId}/runs`, { windowStart: '2026-03-02T00:00:00Z', windowEnd: '2026-03-03T00:00:00Z' });
    expect(res.json().error).toBe('PROVIDER_NOT_CONFIGURED');
  });
});

describe('a run under a request deadline (docs/09 §8.2): it always ends, so the profile can run again', () => {
  const activeProfile = async (code: string) => {
    const p = await setupProfile(code, A_FIELDS, { dedupeStrategy: 'PROVIDER_EVENT_KEY', timestampRule: 'ISO_WITH_OFFSET' });
    expect((await h.call(admin2, 'POST', `/v1/biometric/mappings/${p.mappingId}/approve`)).statusCode).toBe(200);
    expect((await h.call(admin, 'POST', `/v1/biometric/profiles/${p.profileId}/activate`)).statusCode).toBe(200);
    return p.profileId;
  };
  const runState = async (profileId: string) => (await h.one<{ state: string; failure_code: string | null }>(`select state, failure_code from biometric_sync_run where profile_id = $1 order by created_at desc limit 1`, [profileId]));

  it('a request answered 503 while its provider is slow leaves no run RUNNING; the next run of the profile starts', async () => {
    const profileId = await activeProfile('LATE');
    // The second page answers only after the request has been answered 503.
    let release = () => {};
    const answered = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider: BiometricProvider = {
      async fetchPage({ cursor }) {
        if (!cursor) return { records: [], nextCursor: 'p1' };
        await answered;
        return { records: [], nextCursor: null };
      },
    };
    const budget = { deadlineMs: 1_500 };
    const app = buildApp({ db: h.pool, verifier: devTokenVerifier(tokenConfig), biometricProviders: new Map([['LATE', provider]]), serving: { read: budget, write: budget, batch: budget } });
    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: `/v1/biometric/profiles/${profileId}/runs`,
        payload: { windowStart: '2026-03-02T00:00:00Z', windowEnd: '2026-03-03T00:00:00Z' },
        headers: { authorization: `Bearer ${admin.token}`, [COMPANY_HEADER]: A.id, [ASSIGNMENT_HEADER]: admin.assignment },
      });
      expect(res.statusCode).toBe(503);
      expect(res.headers['retry-after']).toBe('5');
      release();
      // The handler goes on after its answer: its next page cannot commit, and the run must still end by itself.
      for (const end = Date.now() + 5_000; (await runState(profileId)).state === 'RUNNING' && Date.now() < end; ) await new Promise((r) => setTimeout(r, 50));
      expect(await runState(profileId)).toMatchObject({ state: 'PARTIAL', failure_code: 'PROCESSING_FAILED' });
    } finally {
      release();
      await app.close();
    }
    expect(await sync(profileId, provider)).toMatchObject({ state: 'COMPLETED' });
  });

  it('a failing fetch does not wait out a retry delay past the deadline: the run ends FAILED at once', async () => {
    const profileId = await activeProfile('DOWN');
    const provider = new FakeProvider([[]], 0);
    const scope = newScope({ statementTimeoutMs: 15_000, lockTimeoutMs: 5_000 }, Date.now() + 30_000);
    const started = Date.now();
    const run = await runInScope(scope, () =>
      runSync(instrumentDatabase(h.pool), { companyId: A.id, profileId, actorUserId: admin.user, windowStart: new Date('2026-03-02T00:00:00Z'), windowEnd: new Date('2026-03-03T00:00:00Z') }, provider, [60_000]),
    );
    expect(run).toMatchObject({ state: 'FAILED', failureCode: 'FETCH_FAILED' });
    expect(provider.calls).toBe(1);
    expect(Date.now() - started).toBeLessThan(25_000);
    expect(scope.statements).toBeGreaterThan(0);
  });
});

describe('time normalisation and no false absence (BR-036, DF09)', () => {
  it('a local time inside a DST overlap is quarantined, not guessed', async () => {
    const p = await setupProfile(
      'DELTA',
      [
        { sourcePath: 'u', targetField: 'EMPLOYEE_KEY', transformCode: 'TRIM', required: true },
        { sourcePath: 't', targetField: 'PUNCH_INSTANT', transformCode: 'PARSE_INSTANT', required: true },
        { sourcePath: 'd', targetField: 'DIRECTION', transformCode: 'UPPER', required: true },
      ],
      { dedupeStrategy: 'FINGERPRINT', timestampRule: 'LOCAL_IN_PROVIDER_ZONE', timezone: 'America/New_York' },
    );
    await h.call(admin2, 'POST', `/v1/biometric/mappings/${p.mappingId}/approve`);
    await h.call(admin, 'POST', `/v1/biometric/profiles/${p.profileId}/activate`);
    await h.call(admin, 'POST', `/v1/biometric/profiles/${p.profileId}/links`, { externalEmployeeKey: 'NY-1', employeeId: e1.id, effectiveFrom: '2026-01-01T00:00:00Z' });
    const run = await sync(p.profileId, new FakeProvider([[{ u: 'NY-1', t: '2026-11-01 01:30:00', d: 'in' }, { u: 'NY-1', t: '2026-11-01 09:00:00', d: 'in' }]]));
    expect(run).toMatchObject({ accepted: 1, quarantined: 1 });
    const q = await h.one<{ failure_code: string }>(`select failure_code from biometric_ingest_event where profile_id = $1 and state = 'QUARANTINED'`, [p.profileId]);
    expect(q.failure_code).toBe('AMBIGUOUS_LOCAL_TIME');
  });

  it('a failed fetch for the day makes missing punches an exception, never ABSENT', async () => {
    const shift = (await h.call(hr, 'POST', '/v1/shifts', { code: 'DAY', name: 'Day', inTime: '09:00', outTime: '18:00', breaks: [] })).json();
    const policy = (await h.call(hr, 'GET', '/v1/attendance/policies')).json().items[0];
    await h.call(hr, 'POST', `/v1/attendance/policies/${policy.id}/activate`, { expectedVersion: policy.version });
    const worker = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    await h.setStatus(A, worker.id, 'ACTIVE_CONFIRMED');
    await h.call(hr, 'POST', `/v1/employees/${worker.id}/shift`, { shiftId: shift.id, effectiveFrom: '2026-01-05' });
    const p = await setupProfile('EPSILON', A_FIELDS, { dedupeStrategy: 'PROVIDER_EVENT_KEY', timestampRule: 'ISO_WITH_OFFSET' });
    await h.call(admin2, 'POST', `/v1/biometric/mappings/${p.mappingId}/approve`);
    await h.call(admin, 'POST', `/v1/biometric/profiles/${p.profileId}/activate`);
    await h.call(admin, 'POST', `/v1/biometric/profiles/${p.profileId}/links`, { externalEmployeeKey: 'W-1', employeeId: worker.id, effectiveFrom: '2026-01-01T00:00:00Z' });

    expect((await sync(p.profileId, new FakeProvider([[]], 0))).state).toBe('FAILED');
    await h.runBulkJob(hr, '/v1/attendance/processing', { workDate: '2026-03-02' });
    const record = (await h.call(hr, 'GET', `/v1/employees/${worker.id}/attendance?from=2026-03-02&to=2026-03-02`)).json().items[0];
    expect(record).toMatchObject({ status: 'EXCEPTION', exceptionCode: 'PUNCH_SOURCE_UNAVAILABLE' });

    // Once a completed run covers the whole capture window (shift +/- 4 h), the same day evaluates normally.
    expect((await sync(p.profileId, new FakeProvider([[]]), '2026-03-01T12:00:00Z', '2026-03-03T00:00:00Z')).state).toBe('COMPLETED');
    await h.runBulkJob(hr, '/v1/attendance/processing', { workDate: '2026-03-02' });
    expect((await h.call(hr, 'GET', `/v1/employees/${worker.id}/attendance?from=2026-03-02&to=2026-03-02`)).json().items[0].status).toBe('ABSENT');
  });
});
