// BRD line 81 and line 4532: cross-table invariants are tested by direct data writes as well as through the application. These are
// the invariants the B8 record marked API or Partly: CI08, CI14, CI19, CI23, CI25, CI26, CI27, CI28, CI29, CI30. Parts a module
// test already writes directly are named in the comment at each section and not repeated here. Each refusal names the guard's own
// constraint or message, and the same write then passes every remaining check, deferred ones included, with that guard alone
// removed, so a test cannot pass because something else objected. A fixture row is written in replication mode (checks stay on,
// keys and triggers do not) because what is under test is the write that follows it, not how the fixture got there. Synthetic data only.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ForeignKey, foreignKeys, insertRow, quote, type TableShape, tableShapes } from './catalogue.fixtures.js';
import { CHECK_VIOLATION, type CompanyFixture, EXCLUSION_VIOLATION, FK_VIOLATION, fixtures, UNIQUE_VIOLATION } from './fixtures.js';
import { startTestDatabase, type TestDatabase } from './test-database.js';

interface Guard {
  code: string;
  constraint?: string;
  message?: RegExp;
  /** What takes this one guard away, inside a transaction that is rolled back. */
  remove: string;
}

const HASH = 'a'.repeat(64);

describe('cross-table invariants, by direct data writes (BRD lines 81, 4532)', () => {
  let testDb: TestDatabase;
  let db: pg.Client;
  let f: ReturnType<typeof fixtures>;
  let shapes: Map<string, TableShape>;
  let fks: ForeignKey[];
  let a: CompanyFixture;
  let b: CompanyFixture;
  let e1: string;
  let e2: string;
  let u1: string;
  let u2: string;
  let u3: string;
  let seq = 0;

  beforeAll(async () => {
    testDb = await startTestDatabase();
    db = testDb.client;
    f = fixtures(db);
    shapes = await tableShapes(db);
    fks = await foreignKeys(db);
    a = await f.makeCompany();
    b = await f.makeCompany();
    e1 = await f.makeEmployee(a, 'DW1');
    e2 = await f.makeEmployee(a, 'DW2');
    [u1, u2, u3] = [await f.makeUser(), await f.makeUser(), await f.makeUser()];
  });

  afterAll(async () => {
    await testDb?.stop();
  });

  const nextDay = () => {
    seq++;
    return new Date(Date.UTC(2030, 0, 1) + seq * 7 * 86_400_000).toISOString().slice(0, 10);
  };

  let replicaDepth = 0;
  const asReplica = async <T>(write: () => Promise<T>) => {
    if (++replicaDepth === 1) await db.query('set session_replication_role = replica');
    try {
      return await write();
    } finally {
      // In an aborted transaction this cannot run, and the rollback that follows restores the setting anyway.
      if (--replicaDepth === 0) await db.query('set session_replication_role = origin').catch(() => undefined);
    }
  };

  /** A fixture row: checks and unique keys hold, keys and triggers are off. Company A unless it says otherwise. */
  const seed = async (table: string, values: Record<string, string | null>) => {
    const id = values.id ?? randomUUID();
    await asReplica(() => insertRow(db, shapes, table, { id, company_id: a.company, ...values }));
    return id;
  };

  const fkOn = (table: string, ...columns: string[]) => {
    const fk = fks.find((x) => x.child === table && x.childColumns.join() === columns.join());
    if (!fk) throw new Error(`No key on ${table} (${columns.join()})`);
    return fk.name;
  };
  const byKey = (table: string, ...columns: string[]): Guard => {
    const name = fkOn(table, ...columns);
    return { code: FK_VIOLATION, constraint: name, remove: `alter table ${table} drop constraint ${quote(name)}` };
  };
  const byTrigger = (table: string, trigger: string, message: RegExp): Guard => ({ code: CHECK_VIOLATION, message, remove: `alter table ${table} disable trigger ${trigger}` });
  const byCheck = async (table: string, definition: string): Promise<Guard> => {
    const r = await db.query<{ conname: string }>(`select conname::text from pg_constraint where conrelid = $1::regclass and contype = 'c' and pg_get_constraintdef(oid) like $2`, [table, `%${definition}%`]);
    if (r.rowCount !== 1) throw new Error(`Expected one check on ${table} like ${definition}, found ${r.rowCount}`);
    const name = r.rows[0]!.conname;
    return { code: CHECK_VIOLATION, constraint: name, remove: `alter table ${table} drop constraint ${quote(name)}` };
  };
  const byIndex = (index: string): Guard => ({ code: UNIQUE_VIOLATION, constraint: index, remove: `drop index ${index}` });
  const byUnique = async (table: string, ...columns: string[]): Promise<Guard> => {
    const r = await db.query<{ conname: string }>(
      `select con.conname::text from pg_constraint con
        where con.conrelid = $1::regclass and con.contype = 'u'
          and (select array_agg(a.attname::text order by o.ord) from unnest(con.conkey) with ordinality o(attnum, ord) join pg_attribute a on a.attrelid = con.conrelid and a.attnum = o.attnum) = $2::text[]`,
      [table, columns],
    );
    if (r.rowCount !== 1) throw new Error(`No unique key on ${table} (${columns.join()})`);
    const name = r.rows[0]!.conname;
    return { code: UNIQUE_VIOLATION, constraint: name, remove: `alter table ${table} drop constraint ${quote(name)}` };
  };
  const byExclusion = async (table: string): Promise<Guard> => {
    const r = await db.query<{ conname: string }>(`select conname::text from pg_constraint where conrelid = $1::regclass and contype = 'x'`, [table]);
    if (r.rowCount !== 1) throw new Error(`Expected one exclusion on ${table}`);
    const name = r.rows[0]!.conname;
    return { code: EXCLUSION_VIOLATION, constraint: name, remove: `alter table ${table} drop constraint ${quote(name)}` };
  };

  /** Refused by this guard, at the statement or at commit, leaving nothing; then accepted with this guard alone removed, also undone. */
  const refused = async (guard: Guard, write: () => Promise<unknown>) => {
    await db.query('begin');
    let error: { code?: string; constraint?: string; message: string } | null = null;
    try {
      await write();
      await db.query('commit');
    } catch (e) {
      error = e as { code?: string; constraint?: string; message: string };
      await db.query('rollback');
    }
    if (!error) throw new Error('The write was accepted');
    expect({ code: error.code, constraint: error.constraint, message: error.message }).toMatchObject({
      code: guard.code,
      ...(guard.constraint ? { constraint: guard.constraint } : {}),
      ...(guard.message ? { message: expect.stringMatching(guard.message) } : {}),
    });
    await db.query('begin');
    try {
      await db.query(guard.remove);
      await write();
      await db.query('set constraints all immediate');
    } finally {
      await db.query('rollback');
    }
  };

  /** Accepted, and undone: the rule is not refusing more than it should. */
  const accepted = async (write: () => Promise<unknown>) => {
    await db.query('begin');
    try {
      await write();
      await db.query('set constraints all immediate');
    } finally {
      await db.query('rollback');
    }
  };

  const transaction = async (kind: string, owner: string | null, state: string) =>
    (await db.query<{ id: string }>(`insert into business_transaction (company_id, kind, owner_employee_id, state) values ($1, $2, $3, $4) returning id`, [a.company, kind, owner, state])).rows[0]!.id;
  const seedTransaction = async (kind: string, owner: string | null, state: string, company?: string) => {
    const id = randomUUID();
    await asReplica(() => db.query(`insert into business_transaction (id, company_id, kind, owner_employee_id, state) values ($1, $2, $3, $4, $5)`, [id, company ?? a.company, kind, owner, state]));
    return id;
  };

  describe('CI08 leave policy and movements (leave/leave proved these through the API only)', () => {
    let casual: string;
    let sick: string;
    let casualPolicy: string;
    let sickPolicy: string;
    let foreignPolicy: string;
    let request: string;

    const policy = (leaveType: string, company = a.company) =>
      seed('leave_policy', { company_id: company, leave_type_id: leaveType, revision: '1', effective_from: '2026-01-01', eligibility_code: 'ALL', accrual_rule_code: 'NONE', annual_entitlement: '0', state: 'DRAFT' });
    const leaveType = (code: string, company = a.company) => seed('leave_type', { company_id: company, code, name: code, unit: 'DAY', paid: 'true', active: 'true' });

    const insertRequest = async (policyId: string, type: string, employee = e1) => {
      const txn = await transaction('leave_request', employee, 'SUBMITTED');
      const day = nextDay();
      const r = await db.query<{ id: string }>(
        `insert into leave_request (company_id, employee_id, leave_type_id, policy_id, transaction_id, start_date, end_date, requested_units, state) values ($1, $2, $3, $4, $5, $6, $6, 1, 'SUBMITTED') returning id`,
        [a.company, employee, type, policyId, txn, day],
      );
      return r.rows[0]!.id;
    };
    const insertMovement = (employee: string, type: string, key = `move-${randomUUID()}`) =>
      db.query(`insert into leave_movement (company_id, employee_id, leave_type_id, request_id, movement_kind, units, effective_date, idempotency_key) values ($1, $2, $3, $4, 'RESERVATION', -1, '2026-02-02', $5)`, [a.company, employee, type, request, key]);

    beforeAll(async () => {
      casual = await leaveType('CASUAL');
      sick = await leaveType('SICK');
      casualPolicy = await policy(casual);
      sickPolicy = await policy(sick);
      foreignPolicy = await policy(await leaveType('CASUAL', b.company), b.company);
      await db.query('begin');
      request = await insertRequest(casualPolicy, casual);
      await db.query('commit');
    });

    it('a request of a leave type with a policy of that type is accepted', async () => {
      await accepted(() => insertRequest(sickPolicy, sick));
    });

    it('refuses a policy of another leave type on insert', async () => {
      await refused(byKey('leave_request', 'company_id', 'policy_id', 'leave_type_id'), () => insertRequest(sickPolicy, casual));
    });

    it('refuses moving a stored request to a type its policy is not for', async () => {
      await refused(byKey('leave_request', 'company_id', 'policy_id', 'leave_type_id'), () => db.query(`update leave_request set leave_type_id = $2 where id = $1`, [request, sick]));
    });

    it('a movement of the request’s own employee and type is accepted', async () => {
      await accepted(() => insertMovement(e1, casual));
    });

    it('refuses a movement naming another employee', async () => {
      await refused(byKey('leave_movement', 'company_id', 'request_id', 'employee_id', 'leave_type_id'), () => insertMovement(e2, casual));
    });

    it('refuses a movement naming another leave type', async () => {
      await refused(byKey('leave_movement', 'company_id', 'request_id', 'employee_id', 'leave_type_id'), () => insertMovement(e1, sick));
    });

    it('refuses a second movement with the same business key', async () => {
      const key = `move-${randomUUID()}`;
      await insertMovement(e1, casual, key);
      await refused(await byUnique('leave_movement', 'company_id', 'idempotency_key'), () => insertMovement(e1, casual, key));
    });

    it('refuses a cancellation naming someone other than the request’s employee', async () => {
      await refused(byKey('leave_cancellation', 'company_id', 'leave_request_id', 'employee_id'), async () => {
        const txn = await transaction('leave_cancellation', e2, 'SUBMITTED');
        await db.query(`insert into leave_cancellation (company_id, employee_id, leave_request_id, transaction_id, reason, state) values ($1, $2, $3, $4, 'Synthetic', 'SUBMITTED')`, [a.company, e2, request, txn]);
      });
    });

    it('refuses a revision naming another company’s policy (0150)', async () => {
      await refused(byKey('leave_request_revision', 'company_id', 'policy_id'), () =>
        db.query(`insert into leave_request_revision (company_id, request_id, revision, policy_id, start_date, end_date, half_day, requested_units) values ($1, $2, 2, $3, '2026-02-02', '2026-02-02', false, 1)`, [a.company, request, foreignPolicy]),
      );
    });
  });

  describe('CI14 dependent identities', () => {
    // Already direct, not repeated: the feedback's participant and plan (training/training-feedback line 187, "CI14: the participation
    // must belong to the feedback's plan"), the settlement's employee through its exit case (lifecycle/settlement line 417), and a
    // line's activity linked to its job (timesheet/timesheets line 125).
    let sheet: string;
    let week: string;
    let project: string;
    let otherProject: string;
    let job: string;
    let activity: string;

    const master = (table: string, extra: Record<string, string>) => seed(table, { code: `M${++seq}`, name: 'Synthetic', owner_employee_id: e1, start_date: '2026-01-01', active: 'true', ...extra });
    const insertLine = (values: { workDate?: string; projectId?: string; periodStart?: string }) =>
      db.query(
        `insert into timesheet_line (company_id, timesheet_id, employee_id, revision, period_start, work_date, project_id, job_id, activity_id, minutes, productive, source) values ($1, $2, $3, 1, $4, $5, $6, $7, $8, 60, true, 'MANUAL')`,
        [a.company, sheet, e1, values.periodStart ?? week, values.workDate ?? week, values.projectId ?? project, job, activity],
      );

    beforeAll(async () => {
      week = '2026-03-02'; // a Monday
      project = await master('timesheet_project', {});
      otherProject = await master('timesheet_project', {});
      job = await master('timesheet_job', { project_id: project });
      activity = await master('timesheet_activity', { productive: 'true' });
      await seed('timesheet_job_activity', { job_id: job, activity_id: activity, active: 'true' });
      const txn = await seedTransaction('timesheet', e1, 'DRAFT');
      sheet = await seed('timesheet', { employee_id: e1, period_start: week, period_end: '2026-03-08', due_date: '2026-03-09', transaction_id: txn, state: 'DRAFT', current_revision: '1' });
      await seed('timesheet_revision', { timesheet_id: sheet, employee_id: e1, revision: '1', origin: 'INITIAL', state: 'DRAFT' });
    });

    it('a line inside the week, on its job’s project, is accepted', async () => {
      await accepted(() => insertLine({}));
      await accepted(() => insertLine({ workDate: '2026-03-08' }));
    });

    it('refuses a work date before or after the week', async () => {
      const guard = await byCheck('timesheet_line', 'work_date >= period_start');
      await refused(guard, () => insertLine({ workDate: '2026-03-01' }));
      await refused(guard, () => insertLine({ workDate: '2026-03-09' }));
    });

    it('refuses a period that is not the timesheet’s', async () => {
      await refused(byKey('timesheet_line', 'company_id', 'timesheet_id', 'period_start'), () => insertLine({ periodStart: '2026-03-09', workDate: '2026-03-09' }));
    });

    it('refuses a project the job is not on', async () => {
      await refused(byKey('timesheet_line', 'company_id', 'job_id', 'project_id'), () => insertLine({ projectId: otherProject }));
    });
  });

  describe('CI19 biometric profile, run and punch (biometric/biometric proved these through the API only)', () => {
    let profile: string;
    let otherProfile: string;
    let mapping: string;
    let otherMapping: string;
    let run: string;
    let otherRun: string;
    let punch: string;
    const instant = '2026-04-01T09:00:00.000Z';
    const LINK = 'EXT-1';
    const OTHER_LINK = 'EXT-2';

    const makeProfile = () =>
      seed('biometric_profile', { code: `P${++seq}`, name: 'Synthetic', request_config_reference: 'config', auth_reference: 'auth', provider_timezone: 'UTC', pagination_mode: 'CURSOR', schedule_reference: 'schedule', lookback_minutes: '60', active: 'true' });
    const makeMapping = (profileId: string) => seed('biometric_mapping_revision', { profile_id: profileId, revision: '1', effective_from: '2026-01-01T00:00:00Z', dedupe_strategy: 'PROVIDER_EVENT_KEY', timestamp_rule: 'ISO_WITH_OFFSET' });
    const finishedRun = (profileId: string, mappingId: string) =>
      seed('biometric_sync_run', { profile_id: profileId, mapping_revision_id: mappingId, window_start: '2026-01-01T00:00:00Z', window_end: '2026-01-02T00:00:00Z', state: 'COMPLETED', finished_at: '2026-01-02T00:00:00Z' });
    const insertRun = (profileId: string, mappingId: string, counts: Partial<Record<'source_observation_count' | 'accepted_count', number>> = {}) =>
      db.query(
        `insert into biometric_sync_run (company_id, profile_id, mapping_revision_id, window_start, window_end, state, source_observation_count, accepted_count)
         values ($1, $2, $3, '2026-01-01', '2026-01-02', 'RUNNING', $4, $5)`,
        [a.company, profileId, mappingId, counts.source_observation_count ?? 0, counts.accepted_count ?? 0],
      );
    const insertEvent = (values: { employee?: string; time?: string; direction?: string; profile?: string; mapping?: string; run?: string; key?: string; external?: string; punch?: string }) =>
      db.query(
        `insert into biometric_ingest_event (company_id, profile_id, first_run_id, latest_run_id, mapping_revision_id, source_event_key, fingerprint, external_employee_key, employee_id, normalised_time, direction, punch_id, state)
         values ($1, $2, $3, $3, $4, $5, 'fp', $6, $7, $8, $9, $10, 'ACCEPTED')`,
        [a.company, values.profile ?? profile, values.run ?? run, values.mapping ?? mapping, values.key ?? randomUUID(), values.external ?? LINK, values.employee ?? e1, values.time ?? instant, values.direction ?? 'IN', values.punch ?? punch],
      );
    const makePunch = (time: string) => seed('attendance_punch', { employee_id: e1, occurred_at: time, direction: 'IN', source_kind: 'BIOMETRIC_API', source_identity_key: `dw-${++seq}`, biometric_profile_id: profile });
    const link = (profileId: string, external: string, employee: string) => seed('biometric_employee_link', { profile_id: profileId, external_employee_key: external, employee_id: employee, effective_from: '2026-03-01T00:00:00Z', effective_to: '2026-05-01T00:00:00Z' });

    beforeAll(async () => {
      profile = await makeProfile();
      otherProfile = await makeProfile();
      mapping = await makeMapping(profile);
      otherMapping = await makeMapping(otherProfile);
      run = await finishedRun(profile, mapping);
      otherRun = await finishedRun(otherProfile, otherMapping);
      punch = await makePunch(instant);
      // The links the punch tests need, so that only the punch can be what refuses them.
      await link(profile, LINK, e1);
      await link(profile, OTHER_LINK, e2);
      await link(otherProfile, LINK, e1);
    });

    const PUNCH = (): Guard => byTrigger('biometric_ingest_event', 'biometric_event_punch_check', /accepted biometric event does not match its punch/);

    it('a run pinned to its profile’s mapping and an event matching its punch are accepted', async () => {
      await accepted(() => insertRun(profile, mapping));
      await accepted(() => insertEvent({}));
    });

    it('refuses a run pinned to another profile’s mapping', async () => {
      await refused(byKey('biometric_sync_run', 'company_id', 'mapping_revision_id', 'profile_id'), () => insertRun(profile, otherMapping));
    });

    it('refuses counters that do not reconcile to the observations', async () => {
      await refused(await byCheck('biometric_sync_run', 'source_observation_count = (((accepted_count'), () => insertRun(profile, mapping, { source_observation_count: 2, accepted_count: 1 }));
    });

    it('refuses a second running run of one profile', async () => {
      await insertRun(profile, mapping);
      await refused(byIndex('biometric_one_running_run'), () => insertRun(profile, mapping));
      await db.query(`update biometric_sync_run set state = 'FAILED', finished_at = now() where profile_id = $1 and state = 'RUNNING'`, [profile]);
    });

    it('refuses an accepted event whose employee is not the punch’s', async () => {
      await refused(PUNCH(), () => insertEvent({ employee: e2, external: OTHER_LINK }));
    });

    describe('the link covers the event (0151)', () => {
      const COVERS = (): Guard => byTrigger('biometric_ingest_event', 'biometric_event_link_covers', /needs the employee's link to its provider identity at that instant/);

      it('refuses an accepted event after the link ended and before it began', async () => {
        for (const time of ['2026-05-01T00:00:00.000Z', '2026-02-28T23:59:59.000Z']) {
          const matching = await makePunch(time);
          await refused(COVERS(), () => insertEvent({ time, punch: matching }));
        }
      });

      it('refuses an accepted event under a provider identity that is someone else’s', async () => {
        await refused(COVERS(), () => insertEvent({ external: OTHER_LINK }));
      });

      it('refuses an accepted event under a provider identity nobody holds', async () => {
        await refused(COVERS(), () => insertEvent({ external: 'NOBODY' }));
      });

      it('refuses accepting a quarantined event with no link, and leaves a quarantined event alone', async () => {
        const quarantined = randomUUID();
        await db.query(
          `insert into biometric_ingest_event (id, company_id, profile_id, first_run_id, latest_run_id, mapping_revision_id, source_event_key, fingerprint, external_employee_key, normalised_time, direction, state, failure_code)
           values ($1, $2, $3, $4, $4, $5, $6, 'fp', 'NOBODY', $7, 'IN', 'QUARANTINED', 'UNKNOWN_EMPLOYEE')`,
          [quarantined, a.company, profile, run, mapping, randomUUID(), instant],
        );
        await refused(COVERS(), () => db.query(`update biometric_ingest_event set state = 'ACCEPTED', employee_id = $2, punch_id = $3, failure_code = null where id = $1`, [quarantined, e1, punch]));
      });
    });

    it('refuses an accepted event at another instant than the punch', async () => {
      await refused(PUNCH(), () => insertEvent({ time: '2026-04-01T09:00:01.000Z' }));
    });

    it('refuses an accepted event in another direction than the punch', async () => {
      await refused(PUNCH(), () => insertEvent({ direction: 'OUT' }));
    });

    it('refuses an accepted event of another profile than the punch’s', async () => {
      await refused(PUNCH(), () => insertEvent({ profile: otherProfile, mapping: otherMapping, run: otherRun }));
    });

    it('refuses an event repeating a source key within its profile, and allows it in another', async () => {
      const key = `key-${randomUUID()}`;
      await insertEvent({ key });
      await refused(await byUnique('biometric_ingest_event', 'company_id', 'profile_id', 'source_event_key'), () => insertEvent({ key }));
    });

    it('refuses an event pinned to another profile’s mapping', async () => {
      await refused(byKey('biometric_ingest_event', 'company_id', 'mapping_revision_id', 'profile_id'), () => insertEvent({ mapping: otherMapping }));
    });
  });

  describe('CI23 role dashboards (dashboard/wave2-dashboards proved these through the API only)', () => {
    let role: string;
    let foreignRole: string;
    let foreignDashboard: string;
    let permission: string;

    const insertDefinition = (roleId: string, code: string, revision: number, state: string) =>
      db.query<{ id: string }>(`insert into role_dashboard_definition (company_id, role_id, dashboard_code, revision, title, state) values ($1, $2, $3, $4, 'Home', $5) returning id`, [a.company, roleId, code, revision, state]);
    const insertWidget = (dashboard: string, code = 'WIDGET') =>
      db.query(
        `insert into role_dashboard_widget (company_id, dashboard_id, permission_id, widget_code, position, title, metric_code, field_group, scope_rule, display_kind) values ($1, $2, $3, $4, ${++seq}, 'Synthetic', 'METRIC', 'operational', 'ASSIGNMENT_SCOPE', 'COUNT')`,
        [a.company, dashboard, permission, code],
      );

    beforeAll(async () => {
      role = await f.id(`insert into role (company_id, code, name, active) values ($1, 'DASH_ROLE', 'Synthetic', true)`, [a.company]);
      foreignRole = await f.id(`insert into role (company_id, code, name, active) values ($1, 'DASH_ROLE', 'Synthetic', true)`, [b.company]);
      foreignDashboard = await f.id(`insert into role_dashboard_definition (company_id, role_id, dashboard_code, revision, title, state) values ($1, $2, 'FOREIGN', 1, 'Home', 'ACTIVE')`, [b.company, foreignRole]);
      permission = await f.makePermission('read', 'operational');
    });

    it('one active definition per role and code; a retired revision does not count', async () => {
      await insertDefinition(role, 'HOME', 1, 'ACTIVE');
      await refused(byIndex('role_dashboard_one_active'), () => insertDefinition(role, 'HOME', 2, 'ACTIVE'));
      await accepted(() => insertDefinition(role, 'HOME', 2, 'RETIRED'));
      await accepted(() => insertDefinition(role, 'OTHER', 1, 'ACTIVE'));
    });

    it('refuses activating a second revision of the same role and code', async () => {
      const second = (await insertDefinition(role, 'SWITCH', 1, 'ACTIVE'), (await insertDefinition(role, 'SWITCH', 2, 'DRAFT')).rows[0]!.id);
      await refused(byIndex('role_dashboard_one_active'), () => db.query(`update role_dashboard_definition set state = 'ACTIVE' where id = $1`, [second]));
    });

    it('refuses a definition of another company’s role', async () => {
      await refused(byKey('role_dashboard_definition', 'company_id', 'role_id'), () => insertDefinition(foreignRole, 'CROSS', 1, 'DRAFT'));
    });

    it('refuses a widget on another company’s dashboard, and a repeated widget code', async () => {
      await refused(byKey('role_dashboard_widget', 'company_id', 'dashboard_id'), () => insertWidget(foreignDashboard));
      const own = (await insertDefinition(role, 'WIDGETS', 1, 'DRAFT')).rows[0]!.id;
      await insertWidget(own, 'ONCE');
      await refused(await byUnique('role_dashboard_widget', 'company_id', 'dashboard_id', 'widget_code'), () => insertWidget(own, 'ONCE'));
    });
  });

  // The payroll fixtures below stand for what processing leaves behind: a locked run, its frozen record and an issued manifest.
  describe('payroll, as processing leaves it', () => {
    let calendar: string;
    let period: string;
    let template: string;
    let bankRevision: string;
    let personal: string;
    let periods = 1;

    const newPeriod = () => {
      const month = String(++periods).padStart(2, '0');
      const last = new Date(Date.UTC(2026, periods, 0)).toISOString().slice(0, 10);
      return seed('payroll_period', { calendar_id: calendar, period_code: `2026-${month}`, financial_year: '2025-26', service_start: `2026-${month}-01`, service_end: last, input_cutoff: `2026-${month}-25`, payment_date: last });
    };
    const lockedRun = async (state = 'PROCESSED_LOCKED', periodId = period, currency = 'INR') => {
      const id = randomUUID();
      const locked = state === 'PROCESSED_LOCKED';
      const processing = state === 'PROCESSED_LOCKED' || state === 'APPROVED';
      const txn = await seedTransaction('payroll_run', null, state);
      await seed('payroll_run', {
        id,
        calendar_id: calendar,
        period_id: periodId,
        lineage_id: id,
        revision: '1',
        transaction_id: txn,
        state,
        scope_token: HASH,
        service_start: '2026-01-01',
        service_end: '2026-01-31',
        input_cutoff: '2026-01-25',
        payment_date: '2026-01-31',
        days_in_month: '31',
        currency_code: currency,
        currency_minor_unit: '2',
        member_count: '1',
        calculation_started_at: '2026-01-26T00:00:00Z',
        calculated_at: '2026-01-26T00:00:00Z',
        calculated_by: u1,
        attendance_basis: 'NOT_CONFIGURED',
        head_count: '1',
        submitted_at: '2026-01-27T00:00:00Z',
        reviewed_at: '2026-01-27T00:00:00Z',
        reviewed_by: u2,
        approved_at: '2026-01-28T00:00:00Z',
        approved_by: u3,
        processing_started_at: processing ? '2026-01-29T00:00:00Z' : null,
        processed_by: processing ? u3 : null,
        processed_at: locked ? '2026-01-29T00:00:00Z' : null,
        lock_version: locked ? '1' : null,
      });
      return id;
    };
    const frozenRecord = (run: string, employee = e1, net = 100, currency = 'INR') =>
      seed('payroll_record', {
        run_id: run,
        employee_id: employee,
        employee_code: 'DW',
        joining_date: '2026-01-05',
        status_code: 'ACTIVE_CONFIRMED',
        calculation_status: 'CALCULATED',
        currency_code: currency,
        days_in_month: '31',
        earnings: String(net),
        reimbursements: '0',
        gross: String(net),
        deductions: '0',
        net: String(net),
        employer_contributions: '0',
        paid_units: '31',
        salary_arrangement_id: randomUUID(),
        bank_status: 'NOT_REQUIRED',
        frozen_at: '2026-01-29T00:00:00Z',
      });
    const manifest = (run: string, lineCount = 1, total = 60, state = 'VALIDATED') =>
      seed('payroll_bank_batch', {
        run_id: run,
        template_id: template,
        batch_revision: String(++seq),
        currency_code: 'INR',
        payment_date: '2026-01-31',
        state,
        line_count: String(lineCount),
        total_amount: String(total),
        manifest_hash: HASH,
        prepared_by: u1,
      });
    const lineValues = (batch: string, run: string, record: string, amount: number, overrides: Record<string, string | null> = {}) => ({
      company_id: a.company,
      batch_id: batch,
      run_id: run,
      line_sequence: String(++seq),
      allocation_key: `PAY-${randomUUID()}-1`,
      payroll_record_id: record,
      employee_id: e1,
      bank_revision_id: bankRevision,
      payable_amount: String(amount),
      currency_code: 'INR',
      ...overrides,
    });
    const insertLine = (batch: string, run: string, record: string, amount: number, overrides: Record<string, string | null> = {}) => insertRow(db, shapes, 'payroll_bank_line', lineValues(batch, run, record, amount, overrides));
    const seedLine = (batch: string, run: string, record: string, amount: number) => asReplica(async () => {
      const id = randomUUID();
      await insertRow(db, shapes, 'payroll_bank_line', { id, ...lineValues(batch, run, record, amount) });
      return id;
    });

    beforeAll(async () => {
      calendar = await seed('payroll_calendar', { code: 'DW_CAL', name: 'Synthetic', currency_code: 'INR', currency_minor_unit: '2', state: 'DRAFT' });
      period = await seed('payroll_period', { calendar_id: calendar, period_code: '2026-01', financial_year: '2025-26', service_start: '2026-01-01', service_end: '2026-01-31', input_cutoff: '2026-01-25', payment_date: '2026-01-31' });
      template = await seed('payroll_bank_template', { template_code: 'DW_TEMPLATE', template_version: '1', name: 'Synthetic', currency_code: 'INR', format_definition: '{}', definition_hash: HASH, bank_specification_reference: 'spec', test_only: 'true', state: 'DRAFT' });
      bankRevision = await seed('employee_private_profile_revision', { employee_id: e1, category: 'BANK', revision: '1', effective_from: '2026-01-01', payload: 'v1.synthetic' });
      personal = await seed('employee_private_profile_revision', { employee_id: e1, category: 'PERSONAL', revision: '1', effective_from: '2026-01-01', payload: 'v1.synthetic' });
    });

    describe('CI25 processed payroll is immutable', () => {
      // Already direct, not repeated: run state, net, lines, segments, members and exceptions of a real processed run are written to
      // directly and refused by message in payroll/runs lines 356-364. This adds what those lines do not prove: that each refusal
      // is that guard's alone, and that delete is refused by name, not merely refused.
      it('refuses a change to a locked run, by its guard alone', async () => {
        const run = await lockedRun();
        await refused(byTrigger('payroll_run', 'payroll_run_guard', /a processed payroll run is locked/), () => db.query(`update payroll_run set updated_by = $2 where id = $1`, [run, u1]));
      });

      it('refuses a change to a frozen record, by its guard alone', async () => {
        const run = await lockedRun();
        // A zero record: it has no lines, so the deferred totals check passes once the immutability guard is gone.
        const record = await frozenRecord(run, e1, 0);
        await refused(byTrigger('payroll_record', 'payroll_record_guard', /a frozen payroll record is immutable/), () => db.query(`update payroll_record set updated_by = $2 where id = $1`, [record, u1]));
      });

      it('refuses deleting a locked run and a frozen record, each by its own trigger', async () => {
        const run = await lockedRun();
        const record = await frozenRecord(run);
        await refused(byTrigger('payroll_record', 'payroll_record_no_delete', /payroll_record rows cannot be deleted/), () => db.query(`delete from payroll_record where id = $1`, [record]));
        const empty = await lockedRun();
        await refused(byTrigger('payroll_run', 'payroll_run_no_delete', /payroll_run rows cannot be deleted/), () => db.query(`delete from payroll_run where id = $1`, [empty]));
      });
    });

    describe('CI26 timesheet adjustment', () => {
      // Already direct, not repeated: one effective adjustment per source revision (payroll-adjustments line 224), the origin period
      // (line 254), fixed amounts (line 291) and never targeting its origin run (line 358). This adds the same-employee keys
      // and the single applied line.
      let sheet: string;
      let othersSheet: string;
      let run: string;
      let record: string;
      let othersRecord: string;
      let otherRun: string;
      let otherRunRecord: string;

      const approvedSheet = async (employee: string) => {
        const txn = await seedTransaction('timesheet', employee, 'APPROVED');
        const id = await seed('timesheet', { employee_id: employee, period_start: '2026-01-05', period_end: '2026-01-11', due_date: '2026-01-12', transaction_id: txn, state: 'APPROVED', current_revision: '1', approved_revision: '1', first_submitted_at: '2026-01-12T00:00:00Z', first_submitted_on: '2026-01-12', late: 'false' });
        await seed('timesheet_revision', { timesheet_id: id, employee_id: employee, revision: '1', origin: 'INITIAL', state: 'APPROVED', submitted_at: '2026-01-30T00:00:00Z', submitted_by: u1, submitted_on: '2026-01-30', late: 'true', decided_at: '2026-02-01T00:00:00Z', decided_by: u2 });
        return id;
      };
      const insertAdjustment = async (values: { sheet?: string; record?: string; run?: string }) => {
        const txn = await transaction('timesheet_adjustment', e1, 'DRAFT');
        await db.query(
          `insert into payroll_adjustment (company_id, employee_id, source_timesheet_id, source_revision, origin_payroll_record_id, origin_run_id, transaction_id, adjustment_kind, currency_code, rule_snapshot)
           values ($1, $2, $3, 1, $4, $5, $6, 'LATE_TIMESHEET', 'INR', '{}')`,
          [a.company, e1, values.sheet ?? sheet, values.record ?? record, values.run ?? run, txn],
        );
      };

      beforeAll(async () => {
        sheet = await approvedSheet(e1);
        othersSheet = await approvedSheet(e2);
        run = await lockedRun();
        record = await frozenRecord(run);
        othersRecord = await frozenRecord(run, e2);
        otherRun = await lockedRun();
        otherRunRecord = await frozenRecord(otherRun);
      });

      it('an adjustment from the employee’s own sheet and record is accepted', async () => {
        await accepted(() => insertAdjustment({}));
      });

      it('refuses a source timesheet of another employee', async () => {
        await refused(byKey('payroll_adjustment', 'company_id', 'source_timesheet_id', 'employee_id'), () => insertAdjustment({ sheet: othersSheet }));
      });

      it('refuses an origin record of another employee', async () => {
        await refused(byKey('payroll_adjustment', 'company_id', 'origin_payroll_record_id', 'employee_id'), () => insertAdjustment({ record: othersRecord }));
      });

      it('refuses an origin record outside its origin run', async () => {
        await refused(byKey('payroll_adjustment', 'company_id', 'origin_payroll_record_id', 'origin_run_id'), () => insertAdjustment({ record: otherRunRecord }));
      });

      // 0206 (I-79): several cases of one record are paid on the same component line, each through its own snapshot row, so a line is no
      // longer one case's alone; what an applied case cannot lack is the policy it was valued under, and a difference.
      it('an applied adjustment was valued under a policy; two of one record may name the same payroll line', async () => {
        const line = randomUUID();
        const applied = async (revision: string, policy: string | null) => {
          const id = randomUUID();
          const txn = await seedTransaction('timesheet_adjustment', e1, 'APPLIED');
          await insertRow(db, shapes, 'payroll_adjustment', {
            id, company_id: a.company, employee_id: e1, source_timesheet_id: sheet, source_revision: revision, origin_payroll_record_id: record, origin_run_id: run, target_run_id: otherRun, transaction_id: txn,
            applied_payroll_line_id: line, adjustment_kind: 'LATE_TIMESHEET', previous_recognized_units: '1', corrected_units: '2', delta_amount: '1', valuation_policy_id: policy, currency_code: 'INR',
            rule_snapshot: '{}', explanation: 'Synthetic', state: 'APPLIED', submitted_at: '2026-02-01T00:00:00Z', decided_at: '2026-02-02T00:00:00Z', decided_by: u2,
          });
        };
        await refused(await byCheck('payroll_adjustment', 'valuation_policy_id IS NOT NULL) AND (delta_amount <>'), () => asReplica(() => applied('1', null)));
        await accepted(() => asReplica(async () => {
          await applied('1', randomUUID());
          await applied('2', randomUUID());
        }));
      });
    });

    describe('CI27 holds and reservations never exceed payable', () => {
      // Already direct, not repeated: a hold beyond the payable amount alone (payroll/holds line 272) and a state written without its
      // payment event (payroll-outputs/bank line 407). This adds what they do not: a reservation and a hold together.
      const LIMIT = /held amounts exceed the payable amount/;
      const reserve = (line: string, amount: number) =>
        db.query(
          `insert into payroll_payment_event (company_id, bank_line_id, sequence, event_kind, event_key, amount, currency_code, event_time, evidence_reference, recorded_by) values ($1, $2, 1, 'RESERVED', $3, $4, 'INR', now(), 'Synthetic', $5)`,
          [a.company, line, `reserve-${randomUUID()}`, amount, u2],
        );
      const hold = (record: string, run: string, amount: number) =>
        seedTransaction('payroll_hold', e1, 'APPROVED_ACTIVE').then((txn) =>
          seed('payroll_hold', {
            idempotency_key: null,
            employee_id: e1, payroll_record_id: record, run_id: run, transaction_id: txn, hold_kind: 'PAYMENT_SAFETY_BLOCK', policy_revision: 'H2', reason_code: 'BANK_MISSING', scope: 'FULL', hold_amount: String(amount), currency_code: 'INR',
            state: 'APPROVED_ACTIVE', proposed_by: u1, effective_date: '2026-01-29', review_due_on: '2026-02-28', release_criterion: 'Synthetic', evidence_reference: 'Synthetic',
          }),
        );

      it('a reservation that fits beside a live hold is accepted', async () => {
        const run = await lockedRun();
        const record = await frozenRecord(run);
        await hold(record, run, 40);
        const line = await seedLine(await manifest(run), run, record, 60);
        await accepted(() => reserve(line, 60));
      });

      it('refuses a reservation that, with a live hold, exceeds the payable amount', async () => {
        const run = await lockedRun();
        const record = await frozenRecord(run);
        await hold(record, run, 50);
        const line = await seedLine(await manifest(run), run, record, 60);
        await refused(byTrigger('payroll_bank_line', 'payroll_bank_line_within_payable', LIMIT), () => reserve(line, 60));
      });

      it('refuses a second reservation of one record beyond the payable amount: a pending outcome is not paid again', async () => {
        const run = await lockedRun();
        const record = await frozenRecord(run);
        const batch = await manifest(run, 2, 120);
        const first = await seedLine(batch, run, record, 60);
        const second = await seedLine(batch, run, record, 60);
        await reserve(first, 60);
        await refused(byTrigger('payroll_bank_line', 'payroll_bank_line_within_payable', LIMIT), () => reserve(second, 60));
      });

      it('refuses a new hold over what is already reserved', async () => {
        const run = await lockedRun();
        const record = await frozenRecord(run);
        const line = await seedLine(await manifest(run), run, record, 60);
        await reserve(line, 60);
        const placeHold = async (amount: number) => {
          const txn = await transaction('payroll_hold', e1, 'APPROVED_ACTIVE');
          await insertRow(db, shapes, 'payroll_hold', {
            idempotency_key: null,
            company_id: a.company, employee_id: e1, payroll_record_id: record, run_id: run, transaction_id: txn, hold_kind: 'PAYMENT_SAFETY_BLOCK', policy_revision: 'H2', reason_code: 'BANK_MISSING', scope: 'FULL', hold_amount: String(amount), currency_code: 'INR',
            state: 'APPROVED_ACTIVE', proposed_by: u1, effective_date: '2026-01-29', review_due_on: '2026-02-28', release_criterion: 'Synthetic', evidence_reference: 'Synthetic',
          });
        };
        await accepted(() => placeHold(40));
        await refused(byTrigger('payroll_hold', 'payroll_hold_within_payable', LIMIT), () => placeHold(41));
      });

      it('refuses a released-hold allocation for a hold still in force', async () => {
        const run = await lockedRun();
        const record = await frozenRecord(run);
        const live = await hold(record, run, 40);
        const batch = await manifest(run, 1, 40);
        await refused(byTrigger('payroll_bank_line', 'payroll_bank_line_guard', /a held allocation is never included before its approved release/), () => insertLine(batch, run, record, 40, { allocation_key: `REL-${randomUUID()}-1`, hold_id: live }));
      });
    });

    describe('CI28 bank manifest', () => {
      // Already direct, not repeated: a state written without its event, a changed event, a deleted batch and a changed hash
      // (payroll-outputs/bank lines 407-410). This adds the reconciliation and the line rules.
      const TOTALS = /a bank manifest's count, currency and control total must equal its lines/;
      /** One function on two tables, and either insert queues it: the guard is both triggers, so proving it takes removing both. */
      const totalsGuard: Guard = {
        code: CHECK_VIOLATION,
        message: TOTALS,
        remove: `alter table payroll_bank_batch disable trigger payroll_bank_batch_totals_match; alter table payroll_bank_line disable trigger payroll_bank_line_totals_match`,
      };
      const insertManifest = async (run: string, lineCount: number, total: number, currency = 'INR') => {
        const id = randomUUID();
        await insertRow(db, shapes, 'payroll_bank_batch', { id, company_id: a.company, run_id: run, template_id: template, batch_revision: String(++seq), currency_code: currency, payment_date: '2026-01-31', state: 'VALIDATED', line_count: String(lineCount), total_amount: String(total), manifest_hash: HASH, prepared_by: u1 });
        return id;
      };

      it('a manifest equal to its lines is accepted', async () => {
        const run = await lockedRun();
        const record = await frozenRecord(run);
        await accepted(async () => insertLine(await insertManifest(run, 1, 60), run, record, 60));
      });

      it('refuses a manifest whose count is not its lines', async () => {
        const run = await lockedRun();
        const record = await frozenRecord(run);
        await refused(totalsGuard, async () => insertLine(await insertManifest(run, 2, 60), run, record, 60));
      });

      it('refuses a manifest whose control total is not its lines', async () => {
        const run = await lockedRun();
        const record = await frozenRecord(run);
        await refused(totalsGuard, async () => insertLine(await insertManifest(run, 1, 61), run, record, 60));
      });

      it('refuses a line in another currency than its manifest', async () => {
        const run = await lockedRun();
        // The record is in that other currency too, so its own key (0151) is satisfied and only the manifest can object.
        const record = await frozenRecord(run, e1, 100, 'USD');
        await refused(totalsGuard, async () => insertLine(await insertManifest(run, 1, 60), run, record, 60, { currency_code: 'USD' }));
      });

      describe('one currency across template, run, manifest and line (0151)', () => {
        let dollarTemplate: string;
        const insertDollarManifest = async (run: string, templateId: string) => {
          const id = randomUUID();
          await insertRow(db, shapes, 'payroll_bank_batch', { id, company_id: a.company, run_id: run, template_id: templateId, batch_revision: String(++seq), currency_code: 'USD', payment_date: '2026-01-31', state: 'VALIDATED', line_count: '1', total_amount: '60', manifest_hash: HASH, prepared_by: u1 });
          return id;
        };

        beforeAll(async () => {
          dollarTemplate = await seed('payroll_bank_template', { template_code: 'DW_TEMPLATE_USD', template_version: '1', name: 'Synthetic', currency_code: 'USD', format_definition: '{}', definition_hash: HASH, bank_specification_reference: 'spec', test_only: 'true', state: 'DRAFT' });
        });

        it('a manifest in the currency of its template and run is accepted', async () => {
          const run = await lockedRun('PROCESSED_LOCKED', period, 'USD');
          const record = await frozenRecord(run, e1, 100, 'USD');
          await accepted(async () => insertLine(await insertDollarManifest(run, dollarTemplate), run, record, 60, { currency_code: 'USD' }));
        });

        it('refuses a manifest in another currency than its template', async () => {
          const run = await lockedRun('PROCESSED_LOCKED', period, 'USD');
          const record = await frozenRecord(run, e1, 100, 'USD');
          await refused(byKey('payroll_bank_batch', 'company_id', 'template_id', 'currency_code'), async () => insertLine(await insertDollarManifest(run, template), run, record, 60, { currency_code: 'USD' }));
        });

        it('refuses a manifest in another currency than its run', async () => {
          const run = await lockedRun();
          const record = await frozenRecord(run, e1, 100, 'USD');
          await refused(byKey('payroll_bank_batch', 'company_id', 'run_id', 'currency_code'), async () => insertLine(await insertDollarManifest(run, dollarTemplate), run, record, 60, { currency_code: 'USD' }));
        });

        it('refuses a line in another currency than its record', async () => {
          const run = await lockedRun('PROCESSED_LOCKED', period, 'USD');
          const record = await frozenRecord(run);
          await refused(byKey('payroll_bank_line', 'company_id', 'payroll_record_id', 'currency_code'), async () => insertLine(await insertDollarManifest(run, dollarTemplate), run, record, 60, { currency_code: 'USD' }));
        });
      });

      it('removing only one of the two totals triggers proves nothing: the other still refuses', async () => {
        const run = await lockedRun();
        const record = await frozenRecord(run);
        await db.query('begin');
        try {
          await db.query(`alter table payroll_bank_batch disable trigger payroll_bank_batch_totals_match`);
          await insertLine(await insertManifest(run, 2, 60), run, record, 60);
          await expect(db.query('set constraints all immediate')).rejects.toMatchObject({ code: CHECK_VIOLATION, message: expect.stringMatching(TOTALS) });
        } finally {
          await db.query('rollback');
        }
      });

      it('refuses a line naming a bank revision of another employee, or a revision that is not bank details', async () => {
        const run = await lockedRun();
        const record = await frozenRecord(run);
        const guard = byTrigger('payroll_bank_line', 'payroll_bank_line_guard', /a bank line references an approved bank revision of the same employee/);
        const batch = await manifest(run);
        const others = await seed('employee_private_profile_revision', { employee_id: e2, category: 'BANK', revision: '1', effective_from: '2026-01-01', payload: 'v1.synthetic' });
        await refused(guard, () => insertLine(batch, run, record, 60, { bank_revision_id: others }));
        await refused(guard, () => insertLine(batch, run, record, 60, { bank_revision_id: personal }));
      });

      it('refuses a line of a run that is not processed', async () => {
        const run = await lockedRun('APPROVED');
        const record = await frozenRecord(run);
        await refused(byTrigger('payroll_bank_line', 'payroll_bank_line_guard', /a bank line pays a frozen record of a processed run only/), async () => insertLine(await manifest(run), run, record, 60));
      });

      it('refuses a line whose record is of another run than its manifest', async () => {
        const run = await lockedRun();
        const otherRun = await lockedRun();
        const record = await frozenRecord(otherRun);
        await refused(byKey('payroll_bank_line', 'company_id', 'payroll_record_id', 'run_id'), async () => insertLine(await manifest(run), run, record, 60));
      });

      it('a replacement cannot pay an allocation key again', async () => {
        const run = await lockedRun();
        const record = await frozenRecord(run);
        const key = `PAY-${randomUUID()}-1`;
        const cancelled = await seed('payroll_bank_batch', {
          run_id: run, template_id: template, batch_revision: String(++seq), currency_code: 'INR', payment_date: '2026-01-31', state: 'CANCELLED', line_count: '1', total_amount: '60', manifest_hash: HASH, prepared_by: u1,
          cancelled_at: '2026-02-01T00:00:00Z', cancelled_by: u2, cancel_reason: 'Synthetic',
        });
        await asReplica(() => insertLine(cancelled, run, record, 60, { allocation_key: key }));
        await refused(await byUnique('payroll_bank_line', 'company_id', 'allocation_key'), async () => insertLine(await insertManifest(run, 1, 60), run, record, 60, { allocation_key: key }));
      });

      it('one open manifest per run', async () => {
        const run = await lockedRun();
        const record = await frozenRecord(run);
        await manifest(run);
        await refused(byIndex('payroll_bank_batch_one_open'), async () => insertLine(await insertManifest(run, 1, 60), run, record, 60));
      });
    });

    describe('CI30 issued output binding', () => {
      // Already direct, not repeated: the hash never changes, nothing is deleted and no tax certificate without its template
      // (payroll-outputs/payslips lines 194-198). This adds the owner, run and publication rules.
      let attachment: string;
      let othersAttachment: string;
      const makeAttachment = (employee: string) => seed('attachment', { owner_user_id: u1, employee_id: employee, content_reference: `ref-${randomUUID()}`, media_type: 'application/pdf', checksum: HASH });
      const insertOutput = (values: { run: string; record: string; attachment?: string; period?: string; version?: number; supersedes?: string; id?: string }) =>
        insertRow(db, shapes, 'employee_issued_output', {
          id: values.id ?? randomUUID(),
          company_id: a.company, employee_id: e1, kind: 'PAYSLIP', period_id: values.period ?? period, period_code: '2026-01', output_version: String(values.version ?? 1), payroll_record_id: values.record, run_id: values.run, publication_state: 'ISSUED',
          attachment_id: values.attachment ?? attachment, content_hash: HASH, file_name: 'payslip.json', issued_at: '2026-02-01T00:00:00Z', issued_by: u1,
          supersedes_output_id: values.supersedes ?? null, supersession_reason: values.supersedes ? 'Synthetic' : null,
        });

      beforeAll(async () => {
        attachment = await makeAttachment(e1);
        othersAttachment = await makeAttachment(e2);
      });

      it('an output bound to the owner’s record, file and locked run is accepted', async () => {
        const run = await lockedRun();
        await accepted(async () => insertOutput({ run, record: await frozenRecord(run) }));
      });

      it('refuses a file of another employee', async () => {
        const run = await lockedRun();
        const record = await frozenRecord(run);
        await refused(byKey('employee_issued_output', 'company_id', 'attachment_id', 'employee_id'), () => insertOutput({ run, record, attachment: othersAttachment }));
      });

      it('refuses a record of another employee', async () => {
        const run = await lockedRun();
        const record = await frozenRecord(run, e2);
        await refused(byKey('employee_issued_output', 'company_id', 'payroll_record_id', 'employee_id'), () => insertOutput({ run, record }));
      });

      it('refuses a record of another run', async () => {
        const run = await lockedRun();
        const otherRun = await lockedRun();
        const record = await frozenRecord(otherRun);
        await refused(byKey('employee_issued_output', 'company_id', 'payroll_record_id', 'run_id'), () => insertOutput({ run, record }));
      });

      it('refuses an output of a run that is not processed', async () => {
        const run = await lockedRun('APPROVED');
        const record = await frozenRecord(run);
        await refused(byTrigger('employee_issued_output', 'employee_issued_output_guard', /a payslip is issued from a processed payroll record only/), () => insertOutput({ run, record }));
      });

      it('refuses an output naming a period other than its run’s (0150)', async () => {
        const run = await lockedRun();
        const record = await frozenRecord(run);
        const other = await newPeriod();
        await refused(byKey('employee_issued_output', 'company_id', 'run_id', 'period_id'), () => insertOutput({ run, record, period: other }));
      });

      it('refuses a second issued output of one owner, kind and period', async () => {
        const own = await newPeriod();
        const run = await lockedRun('PROCESSED_LOCKED', own);
        const record = await frozenRecord(run);
        const first = randomUUID();
        await insertOutput({ id: first, run, record, period: own });
        await refused(byIndex('employee_issued_output_one_issued'), () => insertOutput({ run, record, period: own, version: 2, supersedes: first }));
      });

      it('refuses changing an issued output, and any move but issued to superseded', async () => {
        const own = await newPeriod();
        const run = await lockedRun('PROCESSED_LOCKED', own);
        const record = await frozenRecord(run);
        const id = randomUUID();
        await asReplica(() =>
          insertRow(db, shapes, 'employee_issued_output', { id, company_id: a.company, employee_id: e1, kind: 'PAYSLIP', period_id: own, period_code: '2026-02', output_version: '1', payroll_record_id: record, run_id: run, publication_state: 'SUPERSEDED', attachment_id: attachment, content_hash: HASH, file_name: 'payslip.json', issued_at: '2026-02-01T00:00:00Z', issued_by: u1, superseded_at: '2026-02-02T00:00:00Z' }),
        );
        const guard = (message: RegExp) => byTrigger('employee_issued_output', 'employee_issued_output_guard', message);
        await refused(guard(/an issued output never changes/), () => db.query(`update employee_issued_output set file_name = 'other.json' where id = $1`, [id]));
        await refused(guard(/invalid issued output transition SUPERSEDED -> ISSUED/), () => db.query(`update employee_issued_output set publication_state = 'ISSUED', superseded_at = null where id = $1`, [id]));
      });
    });
  });

  describe('a decided confirmation exception is final (0152; ZT12; found by a race mutant)', () => {
    const FINAL = () => byTrigger('confirmation_exception', 'confirmation_exception_guard', /confirmation exception in APPROVED is final/);
    const decided = () =>
      seed('confirmation_exception', {
        confirmation_id: randomUUID(), employee_id: e1, kind: 'EXTRA_EXTENSION', reason: 'Synthetic', proposed_by: u1, state: 'APPROVED', decided_by: u2, decided_at: '2026-02-01T00:00:00Z', decision_reason: 'Synthetic', decision_key: null,
      });

    it.each([
      ['who decided it', `decided_by = '__U3__'`],
      ['when', `decided_at = '2026-03-01T00:00:00Z'`],
      ['why', `decision_reason = 'Rewritten'`],
      ['under which key', `decision_key = 'rewritten-key'`],
      ['its state', `state = 'REJECTED'`],
    ])('refuses rewriting %s', async (_, set) => {
      const id = await decided();
      await refused(FINAL(), () => db.query(`update confirmation_exception set ${set.replace('__U3__', u3)} where id = $1`, [id]));
    });

    it('still lets a waiting proposal be decided', async () => {
      const id = await seed('confirmation_exception', { confirmation_id: randomUUID(), employee_id: e1, kind: 'EXTRA_EXTENSION', reason: 'Synthetic', proposed_by: u1, state: 'PROPOSED', decision_key: null });
      await accepted(() => db.query(`update confirmation_exception set state = 'APPROVED', decided_by = $2, decided_at = now(), decision_reason = 'Synthetic' where id = $1`, [id, u2]));
    });
  });

  describe('CI29 sensitive revision application (sensitive-change proved these through the API only)', () => {
    const newRequest = async (state: string, category = 'BANK', employee = e1) => {
      const txn = await seedTransaction('sensitive_change', employee, state);
      return seed('employee_sensitive_change_request', {
        employee_id: employee,
        transaction_id: txn,
        category,
        base_revision: '0',
        proposed_effective_date: '2026-03-01',
        proposed_payload: 'v1.synthetic',
        changed_fields: '{account}',
        reason: 'Synthetic',
        state,
        submitted_at: state === 'DRAFT' ? null : '2026-02-01T00:00:00Z',
      });
    };
    /** Each test its own person, so the one-open and interval rules see only its own rows. */
    const person = () => f.makeEmployee(a, `DW-S${++seq}`);
    const IMMUTABLE = () => byTrigger('employee_sensitive_change_request', 'employee_sensitive_change_guard', /a submitted sensitive change is immutable/);

    it('a draft may still be edited', async () => {
      const id = await newRequest('DRAFT', 'BANK', await person());
      await accepted(() => db.query(`update employee_sensitive_change_request set proposed_payload = 'v1.edited' where id = $1`, [id]));
    });

    it.each([
      ['payload', `proposed_payload = 'v1.changed'`],
      ['base revision', `base_revision = 5`],
      ['effective date', `proposed_effective_date = '2026-04-01'`],
      ['changed fields', `changed_fields = '{other}'`],
      ['reason', `reason = 'Changed'`],
    ])('refuses changing a submitted request’s %s', async (_, set) => {
      const id = await newRequest('SUBMITTED', 'BANK', await person());
      await refused(IMMUTABLE(), () => db.query(`update employee_sensitive_change_request set ${set} where id = $1`, [id]));
    });

    it('refuses changing a request’s category, in any state', async () => {
      const id = await newRequest('DRAFT', 'BANK', await person());
      await refused(byTrigger('employee_sensitive_change_request', 'employee_sensitive_change_guard', /sensitive change identity is immutable/), () => db.query(`update employee_sensitive_change_request set category = 'ADDRESS' where id = $1`, [id]));
    });

    it('refuses a second open request of one employee and category', async () => {
      const employee = await person();
      await newRequest('SUBMITTED', 'BANK', employee);
      // Written in replication mode by the fixture, which a unique index still applies to.
      await refused(byIndex('employee_sensitive_change_one_open'), () => newRequest('DRAFT', 'BANK', employee));
      await accepted(() => newRequest('DRAFT', 'ADDRESS', employee));
    });

    it('refuses an applied state without its revision', async () => {
      const id = await newRequest('APPROVED', 'BANK', await person());
      const guard = await byCheck('employee_sensitive_change_request', `(state = 'APPLIED'::text) = (applied_revision_id IS NOT NULL)`);
      await db.query('begin');
      try {
        await expect(db.query(`update employee_sensitive_change_request set state = 'APPLIED', applied_at = now() where id = $1`, [id])).rejects.toMatchObject({ code: guard.code, constraint: guard.constraint });
      } finally {
        await db.query('rollback');
      }
    });

    describe('the revision a request applies', () => {
      const insertRevision = (employee: string, values: { revision: number; from: string; to?: string | null; request?: string | null; category?: string }) =>
        db.query<{ id: string }>(
          `insert into employee_private_profile_revision (id, company_id, employee_id, category, revision, effective_from, effective_to, payload, source_request_id) values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'v1.synthetic', $7) returning id`,
          [a.company, employee, values.category ?? 'BANK', values.revision, values.from, values.to ?? null, values.request ?? null],
        );

      it('applies once: a second revision of one request is refused', async () => {
        const employee = await person();
        const request = await newRequest('APPROVED', 'BANK', employee);
        await insertRevision(employee, { revision: 1, from: '2026-03-01', to: '2026-04-01', request });
        await refused(byIndex('employee_private_profile_one_per_request'), () => insertRevision(employee, { revision: 2, from: '2026-04-01', request }));
      });

      it('refuses a revision of a request of another employee or category', async () => {
        const employee = await person();
        const request = await newRequest('APPROVED', 'BANK', employee);
        const guard = byKey('employee_private_profile_revision', 'company_id', 'source_request_id', 'employee_id', 'category');
        await refused(guard, async () => insertRevision(await person(), { revision: 1, from: '2026-03-01', request }));
        await refused(guard, () => insertRevision(employee, { revision: 1, from: '2026-03-01', category: 'ADDRESS', request }));
      });

      it('refuses overlapping effective dates', async () => {
        const employee = await person();
        await insertRevision(employee, { revision: 1, from: '2026-03-01', to: '2026-05-01' });
        await refused(await byExclusion('employee_private_profile_revision'), () => insertRevision(employee, { revision: 2, from: '2026-04-01' }));
      });

      it('refuses a revision number that is not the next', async () => {
        const employee = await person();
        await refused(byTrigger('employee_private_profile_revision', 'employee_private_profile_revision_guard', /private profile revisions are consecutive/), () => insertRevision(employee, { revision: 2, from: '2026-03-01' }));
      });

      it('refuses changing an approved revision and reopening a closed one', async () => {
        const employee = await person();
        const id = (await insertRevision(employee, { revision: 1, from: '2026-03-01', to: '2026-05-01' })).rows[0]!.id;
        const guard = (message: RegExp) => byTrigger('employee_private_profile_revision', 'employee_private_profile_revision_guard', message);
        await refused(guard(/an approved private profile revision is immutable/), () => db.query(`update employee_private_profile_revision set payload = 'v1.changed' where id = $1`, [id]));
        await refused(guard(/a closed private profile revision cannot be reopened or moved/), () => db.query(`update employee_private_profile_revision set effective_to = null where id = $1`, [id]));
      });
    });
  });
});
