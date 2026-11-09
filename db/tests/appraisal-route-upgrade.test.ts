// Upgrade behaviour of 0177 (BR-013 one-level manager review; FR-043 "Level 1 completes at manager approval"; I-77 item 2): on a
// database whose appraisal routes were provisioned before the reviewer step became conditional, a route no appraisal has used
// is changed in place, and a route in use (immutable, 0002) is retired and followed by the next revision with the condition,
// while the approval already started keeps the revision it pinned. Synthetic data only.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../migrate.js';
import { startEmptyTestDatabase, type TestDatabase } from './test-database.js';

describe('BR-013 0177 on a database whose appraisal routes predate the conditional reviewer step', () => {
  let old: TestDatabase;
  let db: pg.Client;
  let used: { company: string; workflow: string; instance: string };
  let unused: { company: string; workflow: string };

  const routes = async (company: string) =>
    (
      await db.query<{ revision: number; current: boolean; steps: { sequence: number; condition: string | null }[] }>(
        `select d.revision, (d.active and d.effective_from <= now() and (d.effective_to is null or d.effective_to > now())) as current,
                (select json_agg(json_build_object('sequence', s.sequence, 'condition', s.condition_code) order by s.sequence)
                   from workflow_step s where s.company_id = d.company_id and s.workflow_id = d.id) as steps
           from workflow_definition d where d.company_id = $1 and d.kind = 'appraisal' order by d.revision`,
        [company],
      )
    ).rows;

  beforeAll(async () => {
    const empty = await startEmptyTestDatabase();
    if (!empty) throw new Error('An upgrade test needs TEST_PG_ADMIN_URL');
    old = empty;
    db = old.client;
    await migrate(db, { before: '0177' });
    await db.query('set session_replication_role = replica');
    const user = (await db.query<{ id: string }>(`insert into user_account (account_key, active) values ('up.route.provisioner', true) returning id`)).rows[0]!.id;
    const permission = async (action: string) =>
      (await db.query<{ id: string }>(`select id from permission where resource = 'appraisal' and action = $1 and field_group = 'rating'`, [action])).rows[0]!.id;
    const rate = await permission('rate');
    const confirm = await permission('confirm');
    // The route as provisioning wrote it before 0177: the manager's rating, then an unconditional reviewer step.
    const route = async (code: string) => {
      const company = (await db.query<{ id: string }>(`insert into company (code, name, active) values ($1, 'Synthetic', true) returning id`, [code])).rows[0]!.id;
      const workflow = (
        await db.query<{ id: string }>(
          `insert into workflow_definition (company_id, kind, revision, effective_from, active, created_by, updated_by)
           values ($1, 'appraisal', 1, now() - interval '30 days', true, $2, $2) returning id`,
          [company, user],
        )
      ).rows[0]!.id;
      await db.query(
        `insert into workflow_step (company_id, workflow_id, sequence, permission_id, selection_rule, completion_rule, created_by, updated_by)
         values ($1, $2, 1, $3, 'DIRECT_MANAGER', 'ANY_ONE_ELIGIBLE', $5, $5), ($1, $2, 2, $4, 'HR_FALLBACK_LIST', 'ANY_ONE_ELIGIBLE', $5, $5)`,
        [company, workflow, rate, confirm, user],
      );
      return { company, workflow };
    };
    const inUse = await route('UP_ROUTE_USED');
    const transaction = (
      await db.query<{ id: string }>(`insert into business_transaction (company_id, kind, state, created_by) values ($1, 'appraisal', 'SUBMITTED', $2) returning id`, [inUse.company, user])
    ).rows[0]!.id;
    const instance = (
      await db.query<{ id: string }>(
        `insert into approval_instance (company_id, transaction_kind, transaction_id, transaction_revision, workflow_id, state, created_by)
         values ($1, 'appraisal', $2, 1, $3, 'ACTIVE', $4) returning id`,
        [inUse.company, transaction, inUse.workflow, user],
      )
    ).rows[0]!.id;
    used = { ...inUse, instance };
    unused = await route('UP_ROUTE_UNUSED');
    await db.query('set session_replication_role = origin');
    await migrate(db);
  }, 180_000);

  afterAll(async () => {
    await old?.stop();
  });

  it('a route no appraisal used gains the condition in place: still one revision, the only current one', async () => {
    expect(await routes(unused.company)).toEqual([
      {
        revision: 1,
        current: true,
        steps: [
          { sequence: 1, condition: null },
          { sequence: 2, condition: 'APPRAISAL_REVIEWER_LEVEL' },
        ],
      },
    ]);
  });

  it('a route in use is retired unchanged and revision 2 adds the condition; the started approval keeps revision 1', async () => {
    expect(await routes(used.company)).toEqual([
      {
        revision: 1,
        current: false,
        steps: [
          { sequence: 1, condition: null },
          { sequence: 2, condition: null },
        ],
      },
      {
        revision: 2,
        current: true,
        steps: [
          { sequence: 1, condition: null },
          { sequence: 2, condition: 'APPRAISAL_REVIEWER_LEVEL' },
        ],
      },
    ]);
    expect((await db.query<{ workflow_id: string }>(`select workflow_id from approval_instance where id = $1`, [used.instance])).rows[0]!.workflow_id).toBe(used.workflow);
    // Exactly one revision is current for the engine to pick (startApproval: active and effective now).
    const current = await db.query(
      `select 1 from workflow_definition where company_id = $1 and kind = 'appraisal' and active and effective_from <= now() and (effective_to is null or effective_to > now())`,
      [used.company],
    );
    expect(current.rowCount).toBe(1);
  });
});
