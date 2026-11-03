// Cell-portable keys, migration 0071 (docs/09 §3.4 and §13.2 item 6). An upgrade test builds a database at the schema
// 0071 starts from, fills it with synthetic grants, a delegation, an approval route in use, a dashboard widget, outbox
// events and their retry attempts, and applies 0071: every row keeps its data. Each permission reference names the
// same permission as before, now under its derived id, with its version and update time; foreign keys and trigger
// states are as they were. Outbox events keep their values and claim order, and attempts stay linked to their events.
// Derived ids are computed here without the database (RFC 9562 version 8 with SHA-256) and are the same in that
// database, in the separately migrated test template and in the references of a company provisioned in each.
// Synthetic data only.
import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../../../db/migrate.js';
import { CHECK_VIOLATION } from '../../../../db/tests/fixtures.js';
import { startEmptyTestDatabase, type TestDatabase } from '../../../../db/tests/test-database.js';
import { resolveAccess } from '../modules/access/authorize.js';
import { provisionCompany } from '../modules/access/provision.js';
import { type EventDescriber, MODULE_EVENT_DESCRIBERS } from '../modules/events-registry.js';
import { dispatchOutbox } from '../modules/notification/dispatcher.js';
import { type Harness, startHarness } from '../test/harness.js';
import { createPool } from './pool.js';
import type { Queryable } from './queryable.js';

/** The namespace of permission ids (migration 0071). It is part of every id, so it never changes. */
const PERMISSION_NAMESPACE = '7b64b384-0c1e-4231-a0f9-828e2361f23c';

/** RFC 9562 name-based UUID version 8 with SHA-256 (Appendix B.2), computed without the database. */
function uuidV8Sha256(namespace: string, name: string): string {
  const hash = createHash('sha256').update(Buffer.from(namespace.replace(/-/g, ''), 'hex')).update(name, 'utf8').digest();
  hash[6] = (hash[6]! & 0x0f) | 0x80;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
const permissionIdOf = (key: string) => uuidV8Sha256(PERMISSION_NAMESPACE, key);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function one<T extends pg.QueryResultRow>(db: Queryable, sql: string, params: unknown[] = []): Promise<T> {
  const row = (await db.query<T>(sql, params)).rows[0];
  if (!row) throw new Error(`No row: ${sql}`);
  return row;
}
const pick = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o[k]]));

interface CatalogueRow {
  key: string;
  id: string;
  version: number;
  created_at: string;
  updated_at: string;
  own_ess: boolean;
}
const catalogue = async (db: Queryable) =>
  (
    await db.query<CatalogueRow>(
      `select resource || '.' || action || '.' || field_group as key, id::text, version, created_at::text, updated_at::text, own_ess
         from permission order by (resource || '.' || action || '.' || field_group) collate "C"`,
    )
  ).rows;

interface PermissionFk {
  rel: string;
  col: string;
  name: string;
  def: string;
  validated: boolean;
}
/** Every foreign key to permission, from the system catalog (as the migration finds them). */
const permissionFks = async (db: Queryable) =>
  (
    await db.query<PermissionFk>(
      `select c.conrelid::regclass::text as rel, a.attname::text as col, c.conname::text as name, pg_get_constraintdef(c.oid) as def, c.convalidated as validated
         from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
        where c.contype = 'f' and c.confrelid = 'permission'::regclass
        order by 1, 3`,
    )
  ).rows;

interface ReferenceRow {
  id: string;
  key: string | null;
  permission_id: string;
  version: number;
  updated_at: string;
}
/** Each referencing row with the key of the permission it names (null for an orphan), its version and update time. */
async function references(db: Queryable, fks: PermissionFk[]): Promise<Record<string, ReferenceRow[]>> {
  const out: Record<string, ReferenceRow[]> = {};
  for (const fk of fks) {
    out[`${fk.rel}.${fk.col}`] = (
      await db.query<ReferenceRow>(
        `select t.id::text, p.resource || '.' || p.action || '.' || p.field_group as key, t.${fk.col}::text as permission_id, t.version, t.updated_at::text
           from ${fk.rel} t left join permission p on p.id = t.${fk.col} order by t.id`,
      )
    ).rows;
  }
  return out;
}

interface TriggerState {
  rel: string;
  name: string;
  enabled: string;
}
const triggerStates = async (db: Queryable, rels: string[]) =>
  (
    await db.query<TriggerState>(
      `select tgrelid::regclass::text as rel, tgname::text as name, tgenabled::text as enabled
         from pg_trigger where not tgisinternal and tgrelid = any($1::regclass[]) order by 1, 2`,
      [rels],
    )
  ).rows;

let h: Harness;
const seen: string[] = [];
const describers = MODULE_EVENT_DESCRIBERS as Record<string, EventDescriber>;

beforeAll(async () => {
  h = await startHarness();
  describers['cellkeys.probe'] = async (_tx, ev) => {
    seen.push(String(ev.payload.n));
    return null;
  };
  describers['cellkeys.poison'] = async (_tx, ev) => {
    seen.push(String(ev.payload.n));
    throw new TypeError('synthetic describer failure');
  };
});

afterAll(async () => {
  delete describers['cellkeys.probe'];
  delete describers['cellkeys.poison'];
  await h?.stop();
});

interface Seeded {
  companyA: string;
  holder: string;
  assignment: string;
  inUseStep: string;
  /** What updating the step of the route in use answered before the upgrade. */
  frozenBefore: string | null;
}

/** Seconds after 09:00 UTC on 1 Oct 2026. */
const at = (s: number) => new Date(Date.UTC(2026, 9, 1, 9, 0, s)).toISOString();

/** Rows on the schema 0071 starts from, written with plain SQL so that they depend only on the earlier migrations. */
async function seedBeforeUpgrade(db: pg.Client): Promise<Seeded> {
  const q = (sql: string, params: unknown[] = []) => db.query(sql, params);
  const id = async (sql: string, params: unknown[] = []) => (await one<{ id: string }>(db, `${sql} returning id::text`, params)).id;
  const user = () => id(`insert into user_account (account_key, active) values ($1, true)`, [`cellkeys.${randomUUID()}`]);
  const permission = async (key: string) => {
    const [resource, action, fieldGroup] = key.split('.');
    return (await one<{ id: string }>(db, `select id::text from permission where resource = $1 and action = $2 and field_group = $3`, [resource, action, fieldGroup])).id;
  };
  const inTransaction = async <T>(work: () => Promise<T>) => {
    await q('begin');
    try {
      const result = await work();
      await q('commit');
      return result;
    } catch (err) {
      await q('rollback');
      throw err;
    }
  };

  const holder = await user();
  const approver = await user();
  const delegator = await user();
  const delegate = await user();
  const companyA = await id(`insert into company (code, name, active) values ('CELLKEYS_A', 'Cell keys A', true)`);
  const companyB = await id(`insert into company (code, name, active) values ('CELLKEYS_B', 'Cell keys B', true)`);

  // Role ceiling, an approved assignment and its DB109 allowlist.
  const role = await id(`insert into role (company_id, code, name, active, access_class) values ($1, 'HR_ADMINISTRATOR', 'HR Administrator', true, 'ADMIN')`, [companyA]);
  const ceiling = [
    ['employee.read.operational', 'ALLOW'],
    ['leave.approve.operational', 'ALLOW'],
    ['dashboard.read.operational', 'ALLOW'],
    ['employee.update.operational', 'DENY'],
  ] as const;
  for (const [key, effect] of ceiling) {
    await q(`insert into role_permission (company_id, role_id, permission_id, effect) values ($1, $2, $3, $4)`, [companyA, role, await permission(key), effect]);
  }
  const assignment = await id(
    `insert into role_assignment (company_id, user_id, role_id, scope_kind, effective_from, state, approved_by, approved_at)
     values ($1, $2, $3, 'COMPANY', '2026-01-01T00:00:00Z', 'ACTIVE', $4, now())`,
    [companyA, holder, role, approver],
  );
  for (const key of ['employee.read.operational', 'leave.approve.operational']) {
    await q(
      `insert into role_assignment_permission (company_id, role_assignment_id, permission_id, active, effective_from) values ($1, $2, $3, true, '2026-01-01T00:00:00Z')`,
      [companyA, assignment, await permission(key)],
    );
  }
  await q(
    `insert into delegation (company_id, delegator_user_id, delegate_user_id, permission_id, effective_from, effective_to, approved_by)
     values ($1, $2, $3, $4, '2026-01-01T00:00:00Z', '2026-01-15T00:00:00Z', $5)`,
    [companyA, delegator, delegate, await permission('leave.approve.operational'), approver],
  );

  // An approval route in use: its step is frozen (hrms_workflow_step_immutable), and the re-key still re-points it.
  await q(`
    insert into transaction_kind (kind, root_table) values ('cellkeys_probe', 'cellkeys_probe');
    create table cellkeys_probe (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references company (id),
      transaction_kind text not null default 'cellkeys_probe' check (transaction_kind = 'cellkeys_probe'),
      transaction_id uuid not null,
      unique (company_id, transaction_id),
      foreign key (company_id, transaction_kind, transaction_id) references business_transaction (company_id, kind, id) deferrable initially deferred
    );
    insert into transaction_state (kind, state, initial, terminal) values
      ('cellkeys_probe', 'DRAFT', true, false), ('cellkeys_probe', 'SUBMITTED', false, false), ('cellkeys_probe', 'APPROVED', false, true);
    insert into transaction_transition (kind, from_state, to_state) values
      ('cellkeys_probe', 'DRAFT', 'SUBMITTED'), ('cellkeys_probe', 'SUBMITTED', 'APPROVED');`);
  const workflow = await id(`insert into workflow_definition (company_id, kind, revision, effective_from, active) values ($1, 'cellkeys_probe', 1, '2026-01-01T00:00:00Z', false)`, [
    companyA,
  ]);
  const inUseStep = await id(
    `insert into workflow_step (company_id, workflow_id, sequence, permission_id, selection_rule, completion_rule) values ($1, $2, 1, $3, 'DIRECT_MANAGER', 'ANY_ONE_ELIGIBLE')`,
    [companyA, workflow, await permission('leave.approve.operational')],
  );
  const transaction = await inTransaction(async () => {
    const tx = await id(`insert into business_transaction (company_id, kind, owner_employee_id, state) values ($1, 'cellkeys_probe', null, 'DRAFT')`, [companyA]);
    await q(`insert into cellkeys_probe (company_id, transaction_id) values ($1, $2)`, [companyA, tx]);
    return tx;
  });
  await q(`update business_transaction set state = 'SUBMITTED' where id = $1`, [transaction]);
  await q(`insert into approval_instance (company_id, transaction_kind, transaction_id, transaction_revision, workflow_id, state) values ($1, 'cellkeys_probe', $2, 1, $3, 'ACTIVE')`, [
    companyA,
    transaction,
    workflow,
  ]);
  const frozenBefore = await q(`update workflow_step set selection_rule = selection_rule where id = $1`, [inUseStep]).then(
    () => null,
    (err: { code?: string }) => err.code ?? 'error',
  );

  // A role home dashboard widget.
  const dashboard = await id(`insert into role_dashboard_definition (company_id, role_id, dashboard_code, revision, title, state) values ($1, $2, 'HOME', 1, 'Home', 'ACTIVE')`, [
    companyA,
    role,
  ]);
  await q(
    `insert into role_dashboard_widget (company_id, dashboard_id, permission_id, widget_code, position, title, metric_code, field_group, scope_rule, display_kind)
     values ($1, $2, $3, 'ACTIVE_EMPLOYEES', 0, 'Active employees', 'ACTIVE_EMPLOYEES', 'operational', 'ASSIGNMENT_SCOPE', 'COUNT')`,
    [companyA, dashboard, await permission('dashboard.read.operational')],
  );
  // Triggers that are not simply enabled must come back exactly as they were.
  await q(`alter table delegation enable always trigger delegation_touch`);
  await q(`alter table role_dashboard_widget disable trigger role_dashboard_widget_touch`);

  // Outbox events (bigint ids) and their attempts.
  const event = (
    companyId: string,
    name: string,
    createdAt: string,
    extra: { topic?: string; published?: string; attempts?: number; nextAttempt?: string; failed?: string; lastError?: string } = {},
  ) =>
    id(
      `insert into outbox_event (company_id, topic, aggregate_id, dedupe_key, payload, created_at, published_at, attempts, next_attempt_at, failed_at, last_error)
       values ($1, $2, gen_random_uuid(), $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        companyId,
        extra.topic ?? 'cellkeys.probe',
        `cellkeys:${name}`,
        { n: name },
        createdAt,
        extra.published ?? null,
        extra.attempts ?? 0,
        extra.nextAttempt ?? null,
        extra.failed ?? null,
        extra.lastError ?? null,
      ],
    );
  const attempt = (eventId: string, companyId: string, n: number, code: string, occurredAt: string) =>
    q(`insert into outbox_event_attempt (event_id, company_id, attempt, error_code, occurred_at) values ($1, $2, $3, $4, $5)`, [eventId, companyId, n, code, occurredAt]);

  await event(companyA, 'published', '2026-09-29T09:00:00Z', { published: '2026-09-29T09:00:01Z', attempts: 1 });
  const failed = await event(companyA, 'failed', '2026-09-30T09:00:00Z', { attempts: 4, failed: '2026-09-30T09:30:00Z', lastError: 'PG_57014' });
  for (let n = 1; n <= 4; n++) await attempt(failed, companyA, n, 'PG_57014', `2026-09-30T09:0${n}:00Z`);
  await event(companyA, 'a', at(0));
  // One transaction writes b, c and d: one created_at, ids in write order.
  await inTransaction(async () => {
    for (const n of ['b', 'c', 'd']) await event(companyA, n, at(1));
  });
  // A failed first attempt whose retry is due.
  const due = await event(companyA, 'due', at(2), { attempts: 1, nextAttempt: at(62), lastError: 'TypeError' });
  await attempt(due, companyA, 1, 'TypeError', at(2));
  // Two overlapping transactions: the one that started later (created_at) wrote its event first (lower id).
  await event(companyA, 'overlap', at(4));
  await event(companyA, 'late', at(3));
  await event(companyA, 'poison', at(5), { topic: 'cellkeys.poison' });
  // Another company's event, published after one failed attempt.
  const other = await event(companyB, 'other', at(0), { published: at(30), attempts: 2 });
  await attempt(other, companyB, 1, 'TypeError', at(10));

  return { companyA, holder, assignment, inUseStep, frozenBefore };
}

const outboxBefore = async (db: Queryable) =>
  (await db.query<{ old_id: string; data: Record<string, unknown> }>(`select id::text as old_id, to_jsonb(e) - 'id' as data from outbox_event e order by e.id`)).rows;
const outboxAfter = async (db: Queryable) =>
  (await db.query<{ seq: string; id: string; data: Record<string, unknown> }>(`select seq::text, id::text, to_jsonb(e) - 'id' - 'seq' as data from outbox_event e order by e.seq`)).rows;
const attemptsBefore = async (db: Queryable) =>
  (
    await db.query<{ old_event_id: string; data: Record<string, unknown> }>(
      `select event_id::text as old_event_id, to_jsonb(a) - 'id' - 'event_id' as data from outbox_event_attempt a order by a.event_id, a.attempt`,
    )
  ).rows;
/** Attempts joined to their event by (company_id, event_id): an attempt that lost its event would be missing here. */
const attemptsAfter = async (db: Queryable) =>
  (
    await db.query<{ old_event_id: string; event_id: string; id: string; data: Record<string, unknown> }>(
      `select e.seq::text as old_event_id, a.event_id::text, a.id::text, to_jsonb(a) - 'id' - 'event_id' as data
         from outbox_event_attempt a join outbox_event e on e.company_id = a.company_id and e.id = a.event_id
        order by e.seq, a.attempt`,
    )
  ).rows;
const outboxKeys = async (db: Queryable) =>
  (
    await db.query<{ name: string; def: string }>(
      `select conname::text as name, pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid in ('outbox_event'::regclass, 'outbox_event_attempt'::regclass) and contype in ('p', 'u', 'f') order by 1`,
    )
  ).rows;

const TRIGGER_TABLES = ['permission', 'role_permission', 'role_assignment_permission', 'delegation', 'workflow_step', 'role_dashboard_widget', 'outbox_event_attempt'];

describe.runIf(Boolean(process.env.TEST_PG_ADMIN_URL))('upgrading to cell-portable keys (0071) keeps every row', () => {
  let old: TestDatabase;
  let pool: pg.Pool | undefined;
  let seeded: Seeded;
  let appliedUpgrade: string[];
  const before = {} as {
    catalogue: CatalogueRow[];
    fks: PermissionFk[];
    references: Record<string, ReferenceRow[]>;
    triggers: TriggerState[];
    outbox: Awaited<ReturnType<typeof outboxBefore>>;
    attempts: Awaited<ReturnType<typeof attemptsBefore>>;
  };
  const after = {} as {
    catalogue: CatalogueRow[];
    fks: PermissionFk[];
    references: Record<string, ReferenceRow[]>;
    triggers: TriggerState[];
    outbox: Awaited<ReturnType<typeof outboxAfter>>;
    attempts: Awaited<ReturnType<typeof attemptsAfter>>;
    keys: Awaited<ReturnType<typeof outboxKeys>>;
    readyIndex: string;
  };

  beforeAll(async () => {
    const empty = await startEmptyTestDatabase();
    if (!empty) throw new Error('An upgrade test needs TEST_PG_ADMIN_URL');
    old = empty;
    await migrate(old.client, { before: '0071' });
    seeded = await seedBeforeUpgrade(old.client);
    before.catalogue = await catalogue(old.client);
    before.fks = await permissionFks(old.client);
    before.references = await references(old.client, before.fks);
    before.triggers = await triggerStates(old.client, TRIGGER_TABLES);
    before.outbox = await outboxBefore(old.client);
    before.attempts = await attemptsBefore(old.client);

    appliedUpgrade = await migrate(old.client, { before: '0072' });
    after.catalogue = await catalogue(old.client);
    after.fks = await permissionFks(old.client);
    after.references = await references(old.client, after.fks);
    after.triggers = await triggerStates(old.client, TRIGGER_TABLES);
    after.outbox = await outboxAfter(old.client);
    after.attempts = await attemptsAfter(old.client);
    after.keys = await outboxKeys(old.client);
    after.readyIndex = (await one<{ def: string }>(old.client, `select indexdef as def from pg_indexes where indexname = 'outbox_event_ready_idx'`)).def;

    // Everything after 0071, then the code of today runs against it.
    await migrate(old.client);
    // The allowlist entries added below go straight onto an approved assignment, as a fixture (0099 grant bootstrap).
    await old.client.query(`select set_config('hrms.grant_bootstrap', 'on', false)`);
    await old.client.query(`alter table delegation enable trigger delegation_touch`);
    await old.client.query(`alter table role_dashboard_widget enable trigger role_dashboard_widget_touch`);
    pool = createPool(old.connectionString, 2);
    // Every migration runs from an empty database here, as in the global setup, on a machine shared with other test
    // files: allow more than the default hook time.
  }, 600_000);

  afterAll(async () => {
    await pool?.end();
    await old?.stop();
  });

  it('applies 0071 to a database with grants, a delegation, a route in use, a widget, outbox events and attempts', () => {
    expect(appliedUpgrade.some((f) => f.startsWith('0071_cell_portable_keys'))).toBe(true);
    expect(seeded.frozenBefore).toBe(CHECK_VIOLATION);
    expect(before.fks.map((fk) => `${fk.rel}.${fk.col}`)).toEqual([
      'delegation.permission_id',
      'role_assignment_permission.permission_id',
      'role_dashboard_widget.permission_id',
      'role_permission.permission_id',
      'workflow_step.permission_id',
    ]);
    for (const [column, rows] of Object.entries(before.references)) expect(rows.length, column).toBeGreaterThan(0);
    expect(before.outbox.length).toBe(11);
    expect(before.attempts.length).toBe(6);
  });

  it('gives every permission its derived id and keeps the rest of each catalogue row', () => {
    expect(after.catalogue.map((p) => p.key)).toEqual(before.catalogue.map((p) => p.key));
    // The former ids were random in each database.
    expect(before.catalogue.every((p) => UUID_V4.test(p.id))).toBe(true);
    expect(after.catalogue).toEqual(before.catalogue.map((p) => ({ ...p, id: permissionIdOf(p.key) })));
  });

  it('re-points every permission reference to the same permission, keeping its version and update time (no orphan)', () => {
    expect(Object.keys(after.references)).toEqual(Object.keys(before.references));
    for (const [column, rows] of Object.entries(before.references)) {
      expect(rows.every((r) => r.key !== null)).toBe(true);
      expect(after.references[column], column).toEqual(rows.map((r) => ({ ...r, permission_id: permissionIdOf(r.key!) })));
    }
  });

  it('adds back every foreign key to permission with its name and definition, and restores every trigger state', () => {
    expect(after.fks).toEqual(before.fks);
    expect(after.fks.every((fk) => fk.validated)).toBe(true);
    // The catalogue gains its derived-id trigger; every other trigger has the state it had, including the two set apart.
    expect(after.triggers.filter((t) => !(t.rel === 'permission' && t.name === 'permission_derived_id'))).toEqual(before.triggers);
    expect(after.triggers).toEqual(
      expect.arrayContaining([
        { rel: 'delegation', name: 'delegation_touch', enabled: 'A' },
        { rel: 'role_dashboard_widget', name: 'role_dashboard_widget_touch', enabled: 'D' },
        { rel: 'workflow_step', name: 'workflow_step_immutable', enabled: 'O' },
        { rel: 'outbox_event_attempt', name: 'outbox_event_attempt_append_only', enabled: 'O' },
        { rel: 'permission', name: 'permission_derived_id', enabled: 'O' },
      ]),
    );
  });

  it('keeps grants working: the same decisions, the DB109 containment check and the freeze of a route in use', async () => {
    const decide = (key: string) => {
      const [resource, action, fieldGroup] = key.split('.') as [string, string, string];
      return resolveAccess(old.client, { userId: seeded.holder, companyId: seeded.companyA, assignmentId: seeded.assignment, resource, action, fieldGroups: [fieldGroup] });
    };
    expect(await decide('employee.read.operational')).toMatchObject({ allowed: true, allowedFieldGroups: ['operational'] });
    expect(await decide('leave.approve.operational')).toMatchObject({ allowed: true, allowedFieldGroups: ['operational'] });
    expect(await decide('employee.update.operational')).toMatchObject({ allowed: false, reason: 'NO_PERMISSION' }); // the role DENYs it
    expect(await decide('dashboard.read.operational')).toMatchObject({ allowed: false, reason: 'NO_PERMISSION' }); // not in DB109 yet
    // A new allowlist entry names the derived id, and the containment check finds the re-pointed role permission.
    const allow = (key: string) =>
      old.client.query(
        `insert into role_assignment_permission (company_id, role_assignment_id, permission_id, active, effective_from) values ($1, $2, $3, true, '2026-01-01T00:00:00Z')`,
        [seeded.companyA, seeded.assignment, permissionIdOf(key)],
      );
    await allow('dashboard.read.operational');
    expect(await decide('dashboard.read.operational')).toMatchObject({ allowed: true, allowedFieldGroups: ['operational'] });
    await expect(allow('leave.cancel.operational')).rejects.toMatchObject({ code: CHECK_VIOLATION }); // outside the role ceiling
    // The route in use is still frozen and attempts are still append-only.
    await expect(old.client.query(`update workflow_step set selection_rule = selection_rule where id = $1`, [seeded.inUseStep])).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(old.client.query(`update outbox_event_attempt set error_code = error_code`)).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it('keeps every outbox event and links every attempt to its event, under UUID keys', () => {
    // Each event keeps its former identity as its position (seq) and every value it had.
    expect(after.outbox.map((e) => e.seq)).toEqual(before.outbox.map((e) => e.old_id));
    expect(after.outbox.map((e, i) => pick(e.data, Object.keys(before.outbox[i]!.data)))).toEqual(before.outbox.map((e) => e.data));
    expect(after.outbox.every((e) => UUID_V4.test(e.id))).toBe(true);
    expect(new Set(after.outbox.map((e) => e.id)).size).toBe(after.outbox.length);
    // The same attempts, each tied (company and UUID) to the event it was recorded for.
    const newId = new Map(after.outbox.map((e) => [e.seq, e.id]));
    expect(after.attempts.map((a) => ({ old_event_id: a.old_event_id, data: pick(a.data, Object.keys(before.attempts[0]!.data)) }))).toEqual(before.attempts);
    expect(after.attempts.every((a) => a.event_id === newId.get(a.old_event_id) && UUID_V4.test(a.id))).toBe(true);
    expect(after.keys).toEqual(
      expect.arrayContaining([
        { name: 'outbox_event_pkey', def: 'PRIMARY KEY (id)' },
        { name: 'outbox_event_company_id_id_key', def: 'UNIQUE (company_id, id)' },
        { name: 'outbox_event_company_id_dedupe_key_key', def: 'UNIQUE (company_id, dedupe_key)' },
        { name: 'outbox_event_attempt_pkey', def: 'PRIMARY KEY (id)' },
        { name: 'outbox_event_attempt_event_id_attempt_key', def: 'UNIQUE (event_id, attempt)' },
        { name: 'outbox_event_attempt_event_fkey', def: 'FOREIGN KEY (company_id, event_id) REFERENCES outbox_event(company_id, id) ON DELETE RESTRICT' },
      ]),
    );
    expect(after.keys.some((k) => k.name === 'outbox_event_attempt_event_id_fkey')).toBe(false);
    expect(after.readyIndex).toContain('(created_at, seq) WHERE ((published_at IS NULL) AND (failed_at IS NULL))');
  });

  it('claims the kept events oldest first and in write order, retries the due one and records new attempts under the new keys', async () => {
    seen.length = 0;
    await dispatchOutbox(pool!);
    // Successive transactions keep their order, and so do the three events one transaction wrote. Of the two
    // overlapping transactions, the one that started first comes first, though it wrote second (a higher former id).
    expect(seen).toEqual(['a', 'b', 'c', 'd', 'due', 'late', 'overlap', 'poison']);
    const state = (name: string) =>
      one<{ id: string; attempts: number; published: boolean; failed: boolean }>(
        old.client,
        `select id::text, attempts, published_at is not null as published, failed_at is not null as failed from outbox_event where dedupe_key = $1`,
        [`cellkeys:${name}`],
      );
    expect(await state('due')).toMatchObject({ attempts: 2, published: true, failed: false });
    expect(await state('failed')).toMatchObject({ attempts: 4, published: false, failed: true });
    const poison = await state('poison');
    expect(poison).toMatchObject({ attempts: 1, published: false, failed: false });
    expect((await old.client.query(`select attempt, error_code, company_id from outbox_event_attempt where event_id = $1`, [poison.id])).rows).toEqual([
      { attempt: 1, error_code: 'TypeError', company_id: seeded.companyA },
    ]);
    // Nothing is claimed twice, and the dedupe key still admits one event per key.
    seen.length = 0;
    await dispatchOutbox(pool!);
    expect(seen).toEqual([]);
    const again = await old.client.query(
      `insert into outbox_event (company_id, topic, aggregate_id, dedupe_key, payload) values ($1, 'cellkeys.probe', gen_random_uuid(), 'cellkeys:a', '{}'::jsonb)
       on conflict (company_id, dedupe_key) do nothing`,
      [seeded.companyA],
    );
    expect(again.rowCount).toBe(0);
  });

  describe('the same ids in every database', () => {
    let provisioned: { companyId: string; approvedBy: string; effectiveFrom: string };
    const provisionedRefs = async (db: Queryable, companyId: string) => ({
      roles: (
        await db.query<{ role: string; key: string; permission_id: string; effect: string }>(
          `select r.code as role, p.resource || '.' || p.action || '.' || p.field_group as key, rp.permission_id::text, rp.effect
             from role_permission rp join role r on r.company_id = rp.company_id and r.id = rp.role_id join permission p on p.id = rp.permission_id
            where rp.company_id = $1 order by r.code collate "C", rp.permission_id`,
          [companyId],
        )
      ).rows,
      steps: (
        await db.query<{ kind: string; sequence: number; key: string; permission_id: string }>(
          `select w.kind, s.sequence, p.resource || '.' || p.action || '.' || p.field_group as key, s.permission_id::text
             from workflow_step s join workflow_definition w on w.company_id = s.company_id and w.id = s.workflow_id join permission p on p.id = s.permission_id
            where s.company_id = $1 order by w.kind collate "C", s.sequence`,
          [companyId],
        )
      ).rows,
      widgets: (
        await db.query<{ role: string; widget: string; key: string; permission_id: string }>(
          `select r.code as role, wd.widget_code as widget, p.resource || '.' || p.action || '.' || p.field_group as key, wd.permission_id::text
             from role_dashboard_widget wd join role_dashboard_definition d on d.company_id = wd.company_id and d.id = wd.dashboard_id
             join role r on r.company_id = d.company_id and r.id = d.role_id join permission p on p.id = wd.permission_id
            where wd.company_id = $1 order by r.code collate "C", wd.widget_code collate "C"`,
          [companyId],
        )
      ).rows,
    });

    it('reaches the ids of the separately migrated template, and a company provisioned in each gets the same references', async () => {
      // Keys this file adds to the template database itself are left out.
      const released = (rows: CatalogueRow[]) => rows.filter((p) => !p.key.startsWith('cellkeys_')).map((p) => [p.key, p.id]);
      expect(released(await catalogue(old.client))).toEqual(released(await catalogue(h.db)));

      const approvedBy = (await one<{ id: string }>(old.client, `insert into user_account (account_key, active) values ($1, true) returning id::text`, [`cellkeys.${randomUUID()}`])).id;
      const companyId = (await one<{ id: string }>(old.client, `insert into company (code, name, active) values ('CELLKEYS_C', 'Cell keys C', true) returning id::text`)).id;
      provisioned = { companyId, approvedBy, effectiveFrom: '2026-01-01' };
      await provisionCompany(old.client, provisioned);
      const inTemplate = await h.makeCompany();

      const upgraded = await provisionedRefs(old.client, companyId);
      expect(upgraded).toEqual(await provisionedRefs(h.db, inTemplate.id));
      expect(upgraded.roles.length).toBeGreaterThan(100);
      expect(upgraded.steps.length).toBeGreaterThan(5);
      expect(upgraded.widgets.length).toBeGreaterThan(10);
      for (const r of [...upgraded.roles, ...upgraded.steps, ...upgraded.widgets]) expect(r.permission_id).toBe(permissionIdOf(r.key));
    });

    it('provisioning again after the upgrade adds nothing and rewrites nothing', async () => {
      const rows = async () =>
        (
          await old.client.query(
            `select 'role_permission' as t, id::text, version, permission_id::text from role_permission where company_id = $1
             union all select 'workflow_step', id::text, version, permission_id::text from workflow_step where company_id = $1
             union all select 'role_dashboard_widget', id::text, version, permission_id::text from role_dashboard_widget where company_id = $1
             order by 1, 2`,
            [provisioned.companyId],
          )
        ).rows;
      const first = await rows();
      await provisionCompany(old.client, provisioned);
      expect(await rows()).toEqual(first);
    });
  });
});

describe('derived permission ids (0071)', () => {
  it('follows RFC 9562 version 8 with SHA-256 (the Appendix B.2 vector), and every catalogue id is derived from its key', async () => {
    const vector = { namespace: '6ba7b810-9dad-11d1-80b4-00c04fd430c8', name: 'www.example.com', id: '5c146b14-3c52-8afd-938a-375d0df1fbf6' };
    expect(uuidV8Sha256(vector.namespace, vector.name)).toBe(vector.id);
    expect((await one<{ id: string }>(h.db, `select hrms_uuid_v8_sha256($1, $2)::text as id`, [vector.namespace, vector.name])).id).toBe(vector.id);
    expect((await one<{ id: string }>(h.db, `select hrms_permission_id('employee', 'read', 'operational')::text as id`)).id).toBe(permissionIdOf('employee.read.operational'));
    const rows = await catalogue(h.db);
    expect(rows.length).toBeGreaterThan(200);
    expect(rows.filter((p) => p.id !== permissionIdOf(p.key))).toEqual([]);
  });

  it('gives a new permission its derived id and refuses any other id, or a key change without its id', async () => {
    const resource = `cellkeys_${randomUUID().slice(0, 8)}`;
    const insert = (action: string, id: string | null = null) =>
      h.db.query<{ id: string }>(`insert into permission (id, resource, action, field_group) values ($1, $2, $3, 'operational') returning id::text`, [id, resource, action]);
    const created = (await insert('read')).rows[0]!;
    expect(created.id).toBe(permissionIdOf(`${resource}.read.operational`));
    await expect(insert('list', randomUUID())).rejects.toMatchObject({ code: CHECK_VIOLATION });
    expect((await insert('list', permissionIdOf(`${resource}.list.operational`))).rows[0]!.id).toBe(permissionIdOf(`${resource}.list.operational`));
    await expect(h.db.query(`update permission set field_group = 'personal' where id = $1`, [created.id])).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(h.db.query(`update permission set id = gen_random_uuid() where id = $1`, [created.id])).rejects.toMatchObject({ code: CHECK_VIOLATION });
    // A catalogue insert run twice (as migrations write them) stays one row with the same id.
    await h.db.query(`insert into permission (resource, action, field_group) values ($1, 'read', 'operational') on conflict (resource, action, field_group) do nothing`, [resource]);
    expect((await h.db.query(`select id::text from permission where resource = $1 and action = 'read'`, [resource])).rows).toEqual([{ id: created.id }]);
  });
});

describe('immutability trigger for the intra-company partition key (0071, docs/09 §4.3)', () => {
  it('is attached to no table until T-05 picks the key', async () => {
    expect((await one<{ n: number }>(h.db, `select count(*)::int as n from pg_trigger where tgfoid = 'hrms_immutable_columns'::regproc`)).n).toBe(0);
  });

  it('once attached, refuses a change of a named column and allows every other change, alongside hrms_touch', async () => {
    // A table shaped like a business table (B1 common columns, hrms_touch), private to this session.
    await h.db.query(`create temp table cellkeys_partitioned (
      id uuid primary key default gen_random_uuid(), employee_id uuid not null, work_date date not null, note text,
      created_at timestamptz not null default now(), created_by uuid, updated_at timestamptz not null default now(), version integer not null default 1)`);
    await h.db.query(`create trigger cellkeys_partition_key before update on cellkeys_partitioned for each row execute function hrms_immutable_columns('employee_id', 'work_date')`);
    await h.db.query(`create trigger cellkeys_touch before update on cellkeys_partitioned for each row execute function hrms_touch()`);
    const row = await one<{ id: string }>(h.db, `insert into cellkeys_partitioned (employee_id, work_date) values (gen_random_uuid(), '2026-10-01') returning id::text`);
    const changed = await one<{ version: number }>(h.db, `update cellkeys_partitioned set note = 'synthetic', employee_id = employee_id, work_date = work_date where id = $1 returning version`, [
      row.id,
    ]);
    expect(changed.version).toBe(2);
    await expect(h.db.query(`update cellkeys_partitioned set employee_id = gen_random_uuid() where id = $1`, [row.id])).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      message: 'cellkeys_partitioned.employee_id is immutable',
    });
    await expect(h.db.query(`update cellkeys_partitioned set work_date = work_date + 1, note = 'moved' where id = $1`, [row.id])).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      message: 'cellkeys_partitioned.work_date is immutable',
    });
    expect(await one(h.db, `select note, version from cellkeys_partitioned where id = $1`, [row.id])).toEqual({ note: 'synthetic', version: 2 });
  });

  it('refuses a trigger attached wrongly: an unknown column, no column, or an insert trigger', async () => {
    await h.db.query(`create temp table cellkeys_misattached (id int primary key, employee_id uuid)`);
    await h.db.query(`insert into cellkeys_misattached values (1, gen_random_uuid())`);
    const attach = async (name: string, timing: string, args: string) =>
      h.db.query(`create trigger ${name} ${timing} on cellkeys_misattached for each row execute function hrms_immutable_columns(${args})`);
    await attach('typo', 'before update', `'employe_id'`);
    await expect(h.db.query(`update cellkeys_misattached set id = 1`)).rejects.toThrow('cellkeys_misattached has no column employe_id');
    await h.db.query(`drop trigger typo on cellkeys_misattached`);
    await attach('no_columns', 'before update', '');
    await expect(h.db.query(`update cellkeys_misattached set id = 1`)).rejects.toThrow('needs at least one column name');
    await h.db.query(`drop trigger no_columns on cellkeys_misattached`);
    await attach('on_insert', 'before insert', `'employee_id'`);
    await expect(h.db.query(`insert into cellkeys_misattached values (2, gen_random_uuid())`)).rejects.toThrow('must be a row-level update trigger');
  });
});
