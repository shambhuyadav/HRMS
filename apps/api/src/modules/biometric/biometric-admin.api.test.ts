// Biometric administration behind the Profiles, Field Mapping, Employee Mapping and Sync Monitor screens (FR-086, FR-087,
// FR-088; BR-035; BR-036; BR-037; DF09; DF13; ZT05). A fake provider stands in for real devices. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import type { PermissionKey } from '../access/baseline.js';
import { type BiometricProvider, runSync } from './sync.js';

const DUTIES: PermissionKey[] = [
  'biometric.profile_manage.operational',
  'biometric.mapping_manage.operational',
  'biometric.employee_link_manage.operational',
  'biometric.sync_run.operational',
  'biometric.sync_exception_reprocess.operational',
  'biometric.read.operational',
];

const FIELDS = [
  { sourcePath: 'u', targetField: 'EMPLOYEE_KEY', transformCode: 'TRIM', required: true },
  { sourcePath: 't', targetField: 'PUNCH_INSTANT', transformCode: 'PARSE_INSTANT', required: true },
  { sourcePath: 'd', targetField: 'DIRECTION', transformCode: 'UPPER', required: true },
  { sourcePath: 'id', targetField: 'EVENT_KEY', transformCode: 'IDENTITY', required: true },
];
const FROM = '2026-01-01T00:00:00Z';

const pages = (...records: unknown[][]): BiometricProvider => ({
  fetchPage: async ({ cursor }) => {
    const i = cursor ? Number(cursor.slice(1)) : 0;
    return { records: records[i] ?? [], nextCursor: i + 1 < records.length ? `p${i + 1}` : null };
  },
});
const punch = (u: string, t: string, id: string, d = 'in') => ({ u, t, d, id });

describe('biometric administration', () => {
  let h: Harness;
  let A: Company;
  let B: Company;
  let admin: TestActor;
  let admin2: TestActor;
  let hr: TestActor;
  let bAdmin: TestActor;

  const person = async () => {
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
    return e.id as string;
  };
  const profile = async (opts: { timezone?: string; timestampRule?: string; active?: boolean } = {}) => {
    const code = uniq('P').replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 30);
    const p = await h.call(admin, 'POST', '/v1/biometric/profiles', {
      code,
      name: `${code} devices`,
      requestConfigReference: `secret-store://biometric/${code}/request`,
      authReference: `secret-store://biometric/${code}/credential`,
      providerTimezone: opts.timezone ?? 'Asia/Kolkata',
      paginationMode: 'CURSOR',
      scheduleReference: 'every-15-minutes',
      lookbackMinutes: 60,
    });
    expect(p.statusCode, p.body).toBe(201);
    const id = p.json().id as string;
    const m = await h.call(admin, 'POST', `/v1/biometric/profiles/${id}/mappings`, { dedupeStrategy: 'PROVIDER_EVENT_KEY', timestampRule: opts.timestampRule ?? 'ISO_WITH_OFFSET', effectiveFrom: FROM, fields: FIELDS });
    expect(m.statusCode, m.body).toBe(201);
    const mappingId = m.json().mappingRevisionId as string;
    expect((await h.call(admin2, 'POST', `/v1/biometric/mappings/${mappingId}/approve`)).statusCode).toBe(200);
    if (opts.active !== false) expect((await h.call(admin, 'POST', `/v1/biometric/profiles/${id}/activate`)).statusCode).toBe(200);
    return { id, code, mappingId };
  };
  const sync = (profileId: string, provider: BiometricProvider) =>
    runSync(h.pool, { companyId: A.id, profileId, actorUserId: admin.user, windowStart: new Date('2026-03-02T00:00:00Z'), windowEnd: new Date('2026-03-03T00:00:00Z') }, provider, [0]);
  const link = (profileId: string, externalEmployeeKey: string, employeeId: string, extra: Record<string, unknown> = {}) =>
    h.call(admin, 'POST', `/v1/biometric/profiles/${profileId}/links`, { externalEmployeeKey, employeeId, effectiveFrom: FROM, ...extra });
  const linksOf = async (profileId: string, query = '') => (await h.call(admin, 'GET', `/v1/biometric/profiles/${profileId}/links${query}`)).json() as { items: { id: string; externalEmployeeKey: string; employeeId: string; effectiveFrom: string; effectiveTo: string | null; current: boolean; version: number }[]; total: number };
  const auditOf = (recordKey: string) => h.db.query<{ action: string; reason: string | null; after_values: unknown }>(`select action, reason, after_values from audit_event where company_id = $1 and record_key = $2 order by occurred_at`, [A.id, recordKey]);
  const punches = async (profileId: string) => (await h.one<{ n: number }>(`select count(*)::int as n from attendance_punch where biometric_profile_id = $1`, [profileId])).n;

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    B = await h.makeCompany();
    admin = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { extra: DUTIES });
    admin2 = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { extra: DUTIES });
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    bAdmin = await h.actor(B, 'SYSTEM_ADMINISTRATOR', { extra: DUTIES });
  });

  afterAll(async () => {
    await h?.stop();
  });

  describe('employee mapping (FR-088 "versioned effective employee links")', () => {
    it('lists links with paging and filters, audits creation, and never crosses companies', async () => {
      const p = await profile();
      const [e1, e2] = [await person(), await person()];
      const created = await link(p.id, 'DEV-1', e1);
      expect(created.statusCode, created.body).toBe(201);
      expect((await link(p.id, 'DEV-2', e2, { effectiveTo: '2026-02-01T00:00:00Z' })).statusCode).toBe(201);
      expect((await link(p.id, 'DEV-3', e2, { effectiveFrom: '2026-03-01T00:00:00Z', effectiveTo: '2026-02-01T00:00:00Z' })).json().error).toBe('INVALID_PERIOD');

      expect((await auditOf(created.json().id)).rows).toMatchObject([{ action: 'CREATE' }]);
      expect((await linksOf(p.id)).items.map((l) => [l.externalEmployeeKey, l.current])).toEqual([
        ['DEV-1', true],
        ['DEV-2', false],
      ]);
      expect((await linksOf(p.id, '?current=true')).items.map((l) => l.externalEmployeeKey)).toEqual(['DEV-1']);
      expect((await linksOf(p.id, '?search=dev-2')).items.map((l) => l.externalEmployeeKey)).toEqual(['DEV-2']);
      expect(await linksOf(p.id, '?page=2&pageSize=25')).toMatchObject({ items: [], total: 2, page: 2, pageSize: 25 });

      expect((await h.call(bAdmin, 'GET', `/v1/biometric/profiles/${p.id}/links`)).statusCode).toBe(404);
      expect((await h.call(bAdmin, 'POST', `/v1/biometric/profiles/${p.id}/links`, { externalEmployeeKey: 'X', employeeId: e1, effectiveFrom: FROM })).statusCode).toBe(404);
      const id = created.json().id as string;
      expect((await h.call(bAdmin, 'POST', `/v1/biometric/links/${id}/end`, { effectiveTo: '2026-02-01T00:00:00Z', reason: 'x', expectedVersion: 1 })).statusCode).toBe(404);
      expect((await h.call(hr, 'GET', `/v1/biometric/profiles/${p.id}/links`)).statusCode).toBe(403);
    });

    it('ends a wrong link with a reason: later punches quarantine, punches already made stay', async () => {
      const p = await profile();
      const e = await person();
      const id = (await link(p.id, 'WRONG-1', e)).json().id as string;
      expect(await sync(p.id, pages([punch('WRONG-1', '2026-03-02T09:00:00+05:30', 'a1')]))).toMatchObject({ accepted: 1 });

      const end = (body: Record<string, unknown>) => h.call(admin, 'POST', `/v1/biometric/links/${id}/end`, body);
      expect((await end({ effectiveTo: '2026-03-02T00:00:00Z', reason: ' ', expectedVersion: 1 })).statusCode).toBe(400);
      expect((await end({ effectiveTo: '2025-12-01T00:00:00Z', reason: 'Synthetic', expectedVersion: 1 })).json().error).toBe('INVALID_PERIOD');
      expect((await end({ effectiveTo: '2026-03-02T00:00:00Z', reason: 'Synthetic', expectedVersion: 9 })).json().error).toBe('STALE_VERSION');
      // Back-dated: the correction of a wrong link.
      expect((await end({ effectiveTo: '2026-03-02T00:00:00Z', reason: 'Wrong person (synthetic)', expectedVersion: 1 })).statusCode).toBe(200);
      expect((await end({ effectiveTo: '2026-04-02T00:00:00Z', reason: 'Again', expectedVersion: 2 })).json().error).toBe('LINK_ENDED');

      expect(await sync(p.id, pages([punch('WRONG-1', '2026-03-03T09:00:00+05:30', 'a2')]))).toMatchObject({ accepted: 0, quarantined: 1 });
      expect(await punches(p.id)).toBe(1);
      const trail = (await auditOf(id)).rows;
      expect(trail.map((a) => [a.action, a.reason])).toEqual([
        ['CREATE', null],
        ['END', 'Wrong person (synthetic)'],
      ]);
    });

    it('moves an identity to another employee from a date, in one step and with no gap', async () => {
      const p = await profile();
      const [from, to] = [await person(), await person()];
      const id = (await link(p.id, 'MOVE-1', from, { effectiveTo: '2026-12-31T00:00:00Z' })).json().id as string;
      const move = (body: Record<string, unknown>) => h.call(admin, 'POST', `/v1/biometric/links/${id}/supersede`, { reason: 'Device reissued (synthetic)', expectedVersion: 1, ...body });
      expect((await move({ employeeId: to, effectiveFrom: '2027-01-01T00:00:00Z' })).json().error).toBe('INVALID_PERIOD');
      expect((await move({ employeeId: from, effectiveFrom: '2026-03-01T00:00:00Z' })).json().error).toBe('NO_CHANGE');
      const moved = await move({ employeeId: to, effectiveFrom: '2026-03-01T00:00:00Z' });
      expect(moved.statusCode, moved.body).toBe(201);

      const rows = (await linksOf(p.id)).items.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
      expect(rows.map((l) => [l.employeeId, new Date(l.effectiveFrom).toISOString(), l.effectiveTo && new Date(l.effectiveTo).toISOString()])).toEqual([
        [from, '2026-01-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z'],
        [to, '2026-03-01T00:00:00.000Z', '2026-12-31T00:00:00.000Z'],
      ]);
      expect((await auditOf(id)).rows.map((a) => a.action)).toEqual(['CREATE', 'SUPERSEDE']);
      expect((await auditOf(moved.json().id)).rows).toMatchObject([{ action: 'CREATE', reason: 'Device reissued (synthetic)' }]);

      await sync(p.id, pages([punch('MOVE-1', '2026-03-02T09:00:00+05:30', 'm1')]));
      expect((await h.one<{ employee_id: string }>(`select employee_id from attendance_punch where biometric_profile_id = $1`, [p.id])).employee_id).toBe(to);
    });

    it('an administrator cannot link a device identity to their own employee record (DF02; C4)', async () => {
      const own = await person();
      const self = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { extra: DUTIES, employeeId: own });
      const p = await profile();
      expect((await h.call(self, 'POST', `/v1/biometric/profiles/${p.id}/links`, { externalEmployeeKey: 'SELF-1', employeeId: own, effectiveFrom: FROM })).json().error).toBe('SELF_ACTION_NOT_ALLOWED');
    });

    it('a revoked assignment changes nothing after the route guard has passed (ZT05)', async () => {
      const temp = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { extra: DUTIES });
      const p = await profile();
      const e = await person();
      await h.db.query(`update role_assignment set state = 'REVOKED', decision_reason = 'Synthetic revocation' where id = $1`, [temp.assignment]);
      expect((await h.call(temp, 'POST', `/v1/biometric/profiles/${p.id}/links`, { externalEmployeeKey: 'GONE', employeeId: e, effectiveFrom: FROM })).statusCode).toBe(403);
      expect((await linksOf(p.id)).total).toBe(0);
    });
  });

  describe('profiles (FR-088 "Disabling a profile stops new runs, not deletes prior punches")', () => {
    it('disables with a reason, stops new runs, keeps punches, and can be activated again', async () => {
      const p = await profile();
      await link(p.id, 'D-1', await person());
      await sync(p.id, pages([punch('D-1', '2026-03-02T09:00:00+05:30', 'd1')]));
      const current = async () => ((await h.call(admin, 'GET', '/v1/biometric/profiles')).json().items as { id: string; active: boolean; version: number }[]).find((x) => x.id === p.id)!;
      const version = (await current()).version;
      const disable = (body: Record<string, unknown>) => h.call(admin, 'POST', `/v1/biometric/profiles/${p.id}/disable`, { reason: 'Device retired (synthetic)', expectedVersion: version, ...body });
      expect((await disable({ expectedVersion: version + 5 })).json().error).toBe('STALE_VERSION');
      expect((await disable({ reason: '' })).statusCode).toBe(400);
      expect((await disable({})).json()).toEqual({ id: p.id, active: false });
      expect((await disable({ expectedVersion: (await current()).version })).json().error).toBe('INVALID_STATE');

      await expect(sync(p.id, pages([]))).rejects.toMatchObject({ statusCode: 409, code: 'PROFILE_INACTIVE' });
      expect(await punches(p.id)).toBe(1);
      expect(await current()).toMatchObject({ active: false });
      expect((await h.call(admin, 'POST', `/v1/biometric/profiles/${p.id}/activate`)).statusCode).toBe(200);
      expect((await auditOf(p.id)).rows.map((a) => [a.action, a.reason])).toEqual([
        ['CREATE', null],
        ['ACTIVATE', null],
        ['DISABLE', 'Device retired (synthetic)'],
        ['ACTIVATE', null],
      ]);
    });

    it('any one biometric duty reads the profile list, which never carries a reference; no duty is refused', async () => {
      const p = await profile();
      const monitor = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { extra: ['biometric.read.operational'] });
      const listed = await h.call(monitor, 'GET', '/v1/biometric/profiles');
      expect(listed.statusCode).toBe(200);
      expect((listed.json().items as { id: string }[]).some((x) => x.id === p.id)).toBe(true);
      expect(listed.body).not.toContain('secret-store');
      expect((await h.call(await h.actor(A, 'SYSTEM_ADMINISTRATOR'), 'GET', '/v1/biometric/profiles')).statusCode).toBe(403);
    });
  });

  describe('field mapping (FR-086; BR-035 versioned revisions)', () => {
    it('lists revisions with their fields and says which are the caller’s own', async () => {
      const p = await profile({ active: false });
      const draft = await h.call(admin2, 'POST', `/v1/biometric/profiles/${p.id}/mappings`, { dedupeStrategy: 'PROVIDER_EVENT_KEY', timestampRule: 'ISO_WITH_OFFSET', effectiveFrom: '2026-06-01T00:00:00Z', fields: FIELDS });
      const items = (await h.call(admin, 'GET', `/v1/biometric/profiles/${p.id}/mappings`)).json().items as { id: string; revision: number; approved: boolean; ownRevision: boolean; fields: { targetField: string }[] }[];
      expect(items.map((r) => [r.revision, r.approved, r.ownRevision, r.fields.length])).toEqual([
        [2, false, false, 4],
        [1, true, true, 4],
      ]);
      expect(items[0]!.id).toBe(draft.json().mappingRevisionId);
      expect((await h.call(bAdmin, 'GET', `/v1/biometric/profiles/${p.id}/mappings`)).statusCode).toBe(404);
    });

    it('a later revision takes over from its effective date; a run stays pinned to the revision it used', async () => {
      const p = await profile();
      await link(p.id, 'R-1', await person());
      await sync(p.id, pages([punch('R-1', '2026-03-02T09:00:00+05:30', 'r1')]));

      const next = await h.call(admin, 'POST', `/v1/biometric/profiles/${p.id}/mappings`, { dedupeStrategy: 'PROVIDER_EVENT_KEY', timestampRule: 'ISO_WITH_OFFSET', effectiveFrom: '2026-02-01T00:00:00Z', fields: FIELDS });
      const nextId = next.json().mappingRevisionId as string;
      expect((await h.call(admin2, 'POST', `/v1/biometric/mappings/${nextId}/approve`)).statusCode).toBe(200);
      const revisions = await h.db.query<{ revision: number; to: Date | null }>(`select revision, effective_to as to from biometric_mapping_revision where profile_id = $1 order by revision`, [p.id]);
      expect(revisions.rows.map((r) => [r.revision, r.to?.toISOString() ?? null])).toEqual([
        [1, '2026-02-01T00:00:00.000Z'],
        [2, null],
      ]);
      expect((await auditOf(nextId)).rows).toMatchObject([{ action: 'APPROVE', after_values: { operational: { revision: 2, closedRevisions: [1] } } }]);

      await sync(p.id, pages([punch('R-1', '2026-03-02T18:00:00+05:30', 'r2', 'out')]));
      const runs = (await h.call(admin, 'GET', `/v1/biometric/runs?profileId=${p.id}`)).json().items as { mappingRevision: number }[];
      expect(runs.map((r) => r.mappingRevision)).toEqual([2, 1]);

      // Starting no later than the revision in force cannot take over from it: approved revisions never overlap.
      const early = await h.call(admin, 'POST', `/v1/biometric/profiles/${p.id}/mappings`, { dedupeStrategy: 'PROVIDER_EVENT_KEY', timestampRule: 'ISO_WITH_OFFSET', effectiveFrom: '2026-01-15T00:00:00Z', fields: FIELDS });
      expect((await h.call(admin2, 'POST', `/v1/biometric/mappings/${early.json().mappingRevisionId}/approve`)).json().error).toBe('OVERLAPPING_PERIOD');
    });
  });

  describe('sync monitor (FR-087; BR-037)', () => {
    it('lists runs with filters and paging, reconciling counts, for a holder of the read duty in company scope', async () => {
      const p = await profile();
      await link(p.id, 'M-1', await person());
      await sync(p.id, pages([punch('M-1', '2026-03-02T09:00:00+05:30', 'n1'), punch('NOBODY', '2026-03-02T09:00:00+05:30', 'n2')], [{ u: 'M-1', t: 'not-a-time', d: 'in', id: 'n3' }]));
      const failing: BiometricProvider = { fetchPage: async () => { throw new Error('provider unavailable'); } };
      await sync(p.id, failing);
      const list = async (q: string) => (await h.call(admin, 'GET', `/v1/biometric/runs?profileId=${p.id}${q}`)).json();

      expect((await list('')).items.map((r: { state: string }) => r.state)).toEqual(['FAILED', 'COMPLETED']);
      expect((await list('&state=COMPLETED')).items).toMatchObject([{ pagesCommitted: 2, observations: 3, accepted: 1, duplicates: 0, quarantined: 1, rejected: 1, mappingRevision: 1 }]);
      expect((await list('&failed=true')).items).toMatchObject([{ state: 'FAILED', failureCode: 'FETCH_FAILED' }]);
      expect(await list('&page=1&pageSize=25')).toMatchObject({ total: 2, page: 1, pageSize: 25 });
      expect(JSON.stringify(await list(''))).not.toContain('secret-store');
      expect((await h.call(await h.actor(A, 'SYSTEM_ADMINISTRATOR', { extra: ['biometric.read.operational'], departmentFilter: A.dept }), 'GET', '/v1/biometric/runs')).statusCode).toBe(403);
    });

    it('lists rejected and quarantined observations with their evidence and what can be done next', async () => {
      const p = await profile();
      await link(p.id, 'X-1', await person());
      await sync(p.id, pages([punch('X-1', '2026-03-02T09:00:00+05:30', 'x1')]));
      const run = await sync(p.id, pages([punch('X-1', '2026-03-02T09:30:00+05:30', 'x1'), punch('NOBODY', '2026-03-02T09:00:00+05:30', 'x2'), { u: 'X-1', t: 'not-a-time', d: 'in', id: 'x3' }]));
      expect(run).toMatchObject({ quarantined: 2, rejected: 1 });

      const list = async (q = '') => (await h.call(admin, 'GET', `/v1/biometric/exceptions?profileId=${p.id}${q}`)).json();
      const rows = (await list()).items as { failureCode: string; outcome: string; nextStep: string; evidence: Record<string, unknown> | null; kept: Record<string, unknown> | null; eventId: string | null }[];
      const of = (code: string) => rows.find((r) => r.failureCode === code)!;
      expect(rows).toHaveLength(3);
      // The altered repeat shows both what was received and what stays on record; nothing was overwritten.
      expect(of('CONFLICTING_PAYLOAD')).toMatchObject({ outcome: 'QUARANTINED', nextStep: 'NONE', evidence: { employeeKey: 'X-1', instant: '2026-03-02T04:00:00.000Z', direction: 'IN' }, kept: { employeeKey: 'X-1', direction: 'IN' } });
      expect(new Date(String(of('CONFLICTING_PAYLOAD').kept!.instant)).toISOString()).toBe('2026-03-02T03:30:00.000Z');
      expect(of('UNKNOWN_EMPLOYEE')).toMatchObject({ outcome: 'QUARANTINED', nextStep: 'REPROCESS', evidence: { employeeKey: 'NOBODY' }, kept: null });
      expect(of('INVALID_TIMESTAMP')).toMatchObject({ outcome: 'REJECTED', nextStep: 'NONE', evidence: null, eventId: null });

      expect((await list('&outcome=REJECTED')).items).toHaveLength(1);
      expect((await list('&failureCode=UNKNOWN_EMPLOYEE')).items).toHaveLength(1);
      expect(await list('&page=1&pageSize=25')).toMatchObject({ total: 3, page: 1, pageSize: 25 });
      expect((await h.call(hr, 'GET', '/v1/biometric/exceptions')).statusCode).toBe(403);
      expect((await h.call(bAdmin, 'GET', `/v1/biometric/exceptions?profileId=${p.id}`)).json().items).toEqual([]);

      // A reprocessed event no longer counts as open; its observation stays on record as received.
      await link(p.id, 'NOBODY', await person());
      expect((await h.call(admin, 'POST', `/v1/biometric/events/${of('UNKNOWN_EMPLOYEE').eventId}/reprocess`)).json()).toMatchObject({ state: 'ACCEPTED' });
      expect(((await list()).items as { failureCode: string; nextStep: string }[]).find((r) => r.failureCode === 'UNKNOWN_EMPLOYEE')!.nextStep).toBe('RESOLVED');
      expect(((await list('&open=true')).items as { failureCode: string }[]).map((r) => r.failureCode).sort()).toEqual(['CONFLICTING_PAYLOAD', 'INVALID_TIMESTAMP']);
    });
  });

  describe('a run whose process died (DF09 "A single profile run holds its processing lease")', () => {
    const strandedRun = async (profileId: string, mappingId: string, minutesAgo: number, pagesCommitted = 2) =>
      (
        await h.one<{ id: string }>(
          `insert into biometric_sync_run (company_id, profile_id, mapping_revision_id, window_start, window_end, state, pages_committed, committed_checkpoint_reference, updated_at)
           values ($1, $2, $3, now() - interval '3 hours', now() - interval '2 hours', 'RUNNING', $4, 'p2', now() - make_interval(mins => $5)) returning id`,
          [A.id, profileId, mappingId, pagesCommitted, minutesAgo],
        )
      ).id;

    it('the next run ends it past the lease, keeping its checkpoint, and tells support', async () => {
      const p = await profile();
      const stranded = await strandedRun(p.id, p.mappingId, 45);
      expect(await sync(p.id, pages([]))).toMatchObject({ state: 'COMPLETED' });
      expect(await h.one(`select state, failure_code, committed_checkpoint_reference as checkpoint, pages_committed as pages, finished_at is not null as finished from biometric_sync_run where id = $1`, [stranded])).toEqual({
        state: 'PARTIAL',
        failure_code: 'LEASE_EXPIRED',
        checkpoint: 'p2',
        pages: 2,
        finished: true,
      });
      expect((await auditOf(stranded)).rows).toMatchObject([{ action: 'LEASE_EXPIRED' }]);
      expect((await h.one<{ n: number }>(`select count(*)::int as n from outbox_event where company_id = $1 and topic = 'biometric.sync_failed' and aggregate_id = $2`, [A.id, stranded])).n).toBe(1);
    });

    it('a run with nothing committed ends FAILED; a run inside its lease still blocks, even through DF09’s longest retry wait', async () => {
      const p = await profile();
      const stranded = await strandedRun(p.id, p.mappingId, 45, 0);
      expect(await sync(p.id, pages([]))).toMatchObject({ state: 'COMPLETED' });
      expect((await h.one<{ state: string }>(`select state from biometric_sync_run where id = $1`, [stranded])).state).toBe('FAILED');

      const live = await strandedRun(p.id, p.mappingId, 21);
      await expect(sync(p.id, pages([]))).rejects.toMatchObject({ statusCode: 409, code: 'RUN_IN_PROGRESS' });
      expect((await h.one<{ state: string }>(`select state from biometric_sync_run where id = $1`, [live])).state).toBe('RUNNING');
    });

    it('a process still alive behind an ended run commits nothing more, and that ending stands', async () => {
      const p = await profile();
      await link(p.id, 'F-1', await person());
      const provider: BiometricProvider = {
        fetchPage: async ({ cursor }) => {
          if (!cursor) return { records: [punch('F-1', '2026-03-02T09:00:00+05:30', 'f1')], nextCursor: 'p1' };
          // While this slow fetch is out, the next run has found the lease lapsed and ended this run.
          await h.db.query(`update biometric_sync_run set state = 'PARTIAL', failure_code = 'LEASE_EXPIRED', finished_at = now() where profile_id = $1 and state = 'RUNNING'`, [p.id]);
          return { records: [punch('F-1', '2026-03-02T18:00:00+05:30', 'f2', 'out')], nextCursor: null };
        },
      };
      expect(await sync(p.id, provider)).toMatchObject({ state: 'PARTIAL', failureCode: 'LEASE_EXPIRED', pagesCommitted: 1, accepted: 1 });
      expect(await punches(p.id)).toBe(1);
    });
  });

  describe('an ambiguous local time is corrected by a person, never guessed (BR-036; FR-087)', () => {
    // On 1 November 2026 01:30 happens twice in New York: 05:30Z (daylight time) and 06:30Z (standard time).
    const AT = '2026-11-01 01:30:00';

    const ambiguous = async () => {
      const p = await profile({ timezone: 'America/New_York', timestampRule: 'LOCAL_IN_PROVIDER_ZONE' });
      const employeeId = await person();
      await link(p.id, 'NY-1', employeeId);
      expect(await sync(p.id, pages([punch('NY-1', AT, 'ny1')]))).toMatchObject({ quarantined: 1 });
      const row = ((await h.call(admin, 'GET', `/v1/biometric/exceptions?profileId=${p.id}`)).json().items as { eventId: string; nextStep: string; evidence: { localTime: string; instant: string | null } }[])[0]!;
      expect(row).toMatchObject({ nextStep: 'CORRECT_TIME', evidence: { localTime: AT, instant: null } });
      return { profileId: p.id, eventId: row.eventId, employeeId };
    };
    const correct = (a: TestActor, eventId: string, body: Record<string, unknown>) => h.call(a, 'POST', `/v1/biometric/events/${eventId}/correct`, { reason: 'Second reading confirmed on the device (synthetic)', ...body });

    it('accepts one of the two readings with a reason, keeping the source record and an audit', async () => {
      const { profileId, eventId, employeeId } = await ambiguous();
      expect((await correct(admin, eventId, { normalisedTime: '2026-11-01T06:30:00Z', reason: ' ' })).statusCode).toBe(400);
      expect((await correct(admin, eventId, { normalisedTime: '2026-11-01T09:00:00Z' })).json().error).toBe('TIME_NOT_THE_SOURCE_READING');
      expect(await punches(profileId)).toBe(0);

      const done = await correct(admin, eventId, { normalisedTime: '2026-11-01T06:30:00Z' });
      expect(done.json(), done.body).toMatchObject({ eventId, state: 'ACCEPTED' });
      const made = await h.one<{ employee_id: string; occurred_at: Date }>(`select employee_id, occurred_at from attendance_punch where biometric_profile_id = $1`, [profileId]);
      expect(made).toMatchObject({ employee_id: employeeId, occurred_at: new Date('2026-11-01T06:30:00Z') });
      expect((await auditOf(eventId)).rows).toMatchObject([{ action: 'CORRECT_TIME', reason: 'Second reading confirmed on the device (synthetic)' }]);
      // The observation stays as received, and the event is closed to a second correction.
      expect(await h.one(`select outcome, failure_code from biometric_run_observation where ingest_event_id = $1`, [eventId])).toEqual({ outcome: 'QUARANTINED', failure_code: 'AMBIGUOUS_LOCAL_TIME' });
      expect((await correct(admin, eventId, { normalisedTime: '2026-11-01T05:30:00Z' })).json().error).toBe('NOT_CORRECTABLE');
    });

    it('refuses a time with no effective link, an event of another kind, another company and the actor’s own punch', async () => {
      const { eventId, employeeId, profileId } = await ambiguous();
      expect((await correct(bAdmin, eventId, { normalisedTime: '2026-11-01T05:30:00Z' })).statusCode).toBe(404);
      const own = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { extra: DUTIES, user: await h.makeUser() });
      await h.db.query(`insert into user_employee_link (company_id, user_id, employee_id, effective_from) values ($1, $2, $3, '2026-01-01')`, [A.id, own.user, employeeId]);
      expect((await correct(own, eventId, { normalisedTime: '2026-11-01T05:30:00Z' })).json().error).toBe('SELF_ACTION_NOT_ALLOWED');
      const [current] = (await linksOf(profileId)).items;
      expect((await h.call(admin, 'POST', `/v1/biometric/links/${current!.id}/end`, { effectiveTo: '2026-10-01T00:00:00Z', reason: 'Synthetic', expectedVersion: current!.version })).statusCode).toBe(200);
      expect((await correct(admin, eventId, { normalisedTime: '2026-11-01T05:30:00Z' })).json().error).toBe('STILL_UNMATCHED');

      const other = await profile();
      await sync(other.id, pages([punch('NOBODY', '2026-03-02T09:00:00+05:30', 'k1')]));
      const unknown = await h.one<{ id: string }>(`select id from biometric_ingest_event where profile_id = $1`, [other.id]);
      expect((await correct(admin, unknown.id, { normalisedTime: '2026-03-02T03:30:00Z' })).json().error).toBe('NOT_CORRECTABLE');
    });

    it('inside a DST gap no instant reads as the device recorded, so the reason answers for it; a future time is refused', async () => {
      // On 8 March 2026 02:30 does not exist in New York.
      const p = await profile({ timezone: 'America/New_York', timestampRule: 'LOCAL_IN_PROVIDER_ZONE' });
      await link(p.id, 'NY-2', await person());
      await sync(p.id, pages([punch('NY-2', '2026-03-08 02:30:00', 'ny2')]));
      const event = await h.one<{ id: string }>(`select id from biometric_ingest_event where profile_id = $1 and failure_code = 'AMBIGUOUS_LOCAL_TIME'`, [p.id]);
      expect((await correct(admin, event.id, { normalisedTime: '2099-01-01T00:00:00Z' })).json().error).toBe('TIME_IN_FUTURE');
      expect((await correct(admin, event.id, { normalisedTime: '2026-03-08T07:30:00Z' })).json()).toMatchObject({ state: 'ACCEPTED' });
    });
  });
});
