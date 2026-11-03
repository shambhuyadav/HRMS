// CP-08: calculation, processing and verification of a run in bounded chunks, each chunk its own transaction, resumed
// where they stopped; the run's state changes commit only when every chunk has (FR-033, FR-099, CI25, ZT36).
// Synthetic employees and amounts only; small chunk sizes stand in for large companies.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '../../db/transaction.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { isModuleActive } from '../registry.js';
import { calculateRun, processRun as processService, verifyRun } from './runs.js';
import {
  APPROVE,
  bankRevision,
  calendar,
  CONFIG,
  createRun,
  getRun,
  grantOf,
  grants,
  head,
  months,
  ok,
  person,
  PREPARE,
  PROCESS,
  REVIEW,
  reviewers,
  SALARY,
  salary,
  submitAndApprove,
} from './payroll.fixtures.js';

describe.runIf(isModuleActive('payroll'))('chunked calculation and processing (CP-08)', () => {
  let h: Harness;
  let A: Company;
  let hr: TestActor;
  let configA: TestActor;
  let configB: TestActor;
  let preparer: TestActor;
  let otherPreparer: TestActor;
  let reviewer: TestActor;
  let approver: TestActor;
  let processor: TestActor;
  let periods: Record<string, string>;
  let dept: string;
  const staff: string[] = [];

  const chunks = async (runId: string, phase: 'CALCULATE' | 'PROCESS') =>
    (
      await h.db.query<{ sequence: number; records: number; first_employee_id: string; last_employee_id: string }>(
        `select sequence, records, first_employee_id, last_employee_id from payroll_run_chunk where run_id = $1 and phase = $2 order by sequence`,
        [runId, phase],
      )
    ).rows;
  const count = async (sql: string, params: unknown[]) => (await h.one<{ n: number }>(sql, params)).n;
  const prepGrant = () => grantOf(h, preparer, 'payroll_run', 'prepare', ['amount']);
  const procGrant = () => grantOf(h, processor, 'payroll_run', 'process', ['amount']);

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    configA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    configB = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    preparer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(PREPARE, SALARY) });
    otherPreparer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: PREPARE });
    reviewer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REVIEW });
    approver = await h.actor(A, 'HR_ADMINISTRATOR', { extra: APPROVE });
    processor = await h.actor(A, 'HR_ADMINISTRATOR', { extra: PROCESS });
    await reviewers(h, hr, 'payroll_run', [reviewer]);
    await reviewers(h, hr, 'payroll_run_approval', [approver]);
    await head(h, configA, configB, { code: 'CH_BASIC', headType: 'EARNING', basis: 'FIXED', sequence: 1 });
    await head(h, configA, configB, { code: 'CH_DED', headType: 'DEDUCTION', basis: 'FIXED', sequence: 2 });
    periods = (await calendar(h, configA, configB, months(2026))).periods;
    dept = (await h.one<{ id: string }>(`insert into department (company_id, code, name, active) values ($1, 'CHUNKED', 'CHUNKED', true) returning id`, [A.id])).id;
    for (let i = 0; i < 7; i++) {
      const e = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-01-05' });
      const amount = String(10000 + i * 1000);
      await salary(h, preparer, e, { effectiveFrom: '2026-01-05', monthlyGross: amount, components: [{ code: 'CH_BASIC', amount }, { code: 'CH_DED', amount: '100' }] });
      if (i % 2 === 0) await bankRevision(h, A, e);
      staff.push(e);
    }
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('calculates in bounded chunks, resumes where it stopped and keeps the rules fixed at the start for every chunk', async () => {
    // April: a full month for everyone (they joined on 5 January).
    const run = await createRun(h, preparer, periods['2026-04']!, { departmentIds: [dept] });
    // One chunk of three members only (as if the request's share had ended).
    const first = await calculateRun(h.pool, await prepGrant(), run.id, { expectedVersion: run.version }, { chunkSize: 3, maxChunks: 1 });
    expect(first).toMatchObject({ state: 'DRAFT', progress: { calculation: { started: true, members: 7, calculated: 3, chunks: 1, complete: false } } });
    expect(await count(`select count(*)::int as n from payroll_record where run_id = $1`, [run.id])).toBe(3);
    // The API reports an unfinished calculation with 202; only the preparer who started it continues it.
    expect((await h.call(otherPreparer, 'POST', `/v1/payroll/runs/${run.id}/calculate`, { expectedVersion: first.version })).json().error).toBe('CALCULATION_IN_PROGRESS');
    // Once the calculation has started, the confirmed members are fixed.
    expect((await h.call(preparer, 'POST', `/v1/payroll/runs/${run.id}/exclusions`, { employeeIds: [staff[6]], reason: 'x', expectedVersion: first.version })).json().error).toBe('INVALID_STATE');
    // A head revision activated meanwhile is not used by the rest of this revision (H2: rules frozen with it).
    const correction = await ok<{ id: string; version: number }>(
      await h.call(configA, 'POST', '/v1/payroll/heads', {
        componentCode: 'CH_BASIC',
        effectiveFrom: '2020-01-01',
        inUse: true,
        headType: 'EARNING',
        calculationBasis: 'FIXED',
        taxTreatment: 'NON_TAXABLE',
        displaySequence: 1,
      }),
      201,
    );
    await ok(await h.call(configB, 'POST', `/v1/payroll/head-revisions/${correction.id}/activate`, { expectedVersion: correction.version }));
    const second = await calculateRun(h.pool, await prepGrant(), run.id, { expectedVersion: 1 }, { chunkSize: 3 });
    expect(second).toMatchObject({ state: 'CALCULATED', progress: { calculation: { calculated: 7, chunks: 3, complete: true } }, records: { CALCULATED: 7 } });
    const c = await chunks(run.id, 'CALCULATE');
    expect(c.map((x) => [x.sequence, x.records])).toEqual([
      [1, 3],
      [2, 3],
      [3, 1],
    ]);
    // Chunks follow each other without overlap.
    for (let i = 1; i < c.length; i++) expect(c[i]!.first_employee_id > c[i - 1]!.last_employee_id).toBe(true);
    const versions = (await h.db.query<{ rule_version: string }>(`select distinct l.rule_version from payroll_line l join payroll_record r on r.id = l.record_id where r.run_id = $1 and l.component_id = (select id from pay_component where company_id = $2 and code = 'CH_BASIC')`, [run.id, A.id])).rows;
    expect(versions).toEqual([{ rule_version: 'HEAD:CH_BASIC@r1' }]);
    // The run's totals (sums over its chunks) equal the sums of its records.
    const sums = await h.one<{ earnings: string; deductions: string; net: string }>(`select sum(earnings) as earnings, sum(deductions) as deductions, sum(net) as net from payroll_record where run_id = $1`, [run.id]);
    const view = await getRun(h, preparer, run.id);
    expect(view.totals).toEqual([expect.objectContaining({ records: 7, earnings: sums.earnings, deductions: sums.deductions, net: sums.net })]);
    expect(sums).toEqual({ earnings: '91000.0000', deductions: '700.0000', net: '90300.0000' });
    // A replay of the completed calculation changes nothing.
    expect(await calculateRun(h.pool, await prepGrant(), run.id, { expectedVersion: 1 }, { chunkSize: 3 })).toMatchObject({ state: 'CALCULATED', replayed: true });
    // Verification is bounded as well, and resumes from where it stopped.
    const readGrant = await grantOf(h, preparer, 'payroll_run', 'read', ['amount']);
    const v1 = await verifyRun(h.pool, readGrant, run.id, {}, { chunkSize: 3, budgetMs: 0 });
    expect(v1).toMatchObject({ identical: true, records: 3, complete: false });
    const v2 = await verifyRun(h.pool, readGrant, run.id, { after: v1.nextAfter! }, { chunkSize: 3, budgetMs: 60_000 });
    expect(v2).toMatchObject({ identical: true, records: 4, complete: true, nextAfter: null });
  });

  it('processes in bounded chunks with an audit entry each, locks only when every record is frozen, and a failed chunk rolls back whole', async () => {
    const run = await createRun(h, preparer, periods['2026-02']!, { departmentIds: [dept] });
    await calculateRun(h.pool, await prepGrant(), run.id, { expectedVersion: run.version }, { chunkSize: 4 });
    await submitAndApprove(h, { preparer, reviewer, approver }, run.id);
    const approved = await getRun(h, processor, run.id);
    const first = await processService(h.pool, await procGrant(), run.id, { expectedVersion: approved.version }, { chunkSize: 3, maxChunks: 1 });
    expect(first).toMatchObject({ state: 'APPROVED', lockVersion: null, progress: { processing: { started: true, frozen: 3, complete: false } } });
    expect(await count(`select count(*)::int as n from payroll_record where run_id = $1 and frozen_at is not null`, [run.id])).toBe(3);
    expect(await count(`select count(*)::int as n from audit_event where record_key = $1 and action = 'PROCESS_CHUNK'`, [run.id])).toBe(1);
    // Each frozen record without a verified bank instruction has its safety block already, in the same commit.
    expect(
      await count(
        `select count(*)::int as n from payroll_record r where r.run_id = $1 and r.frozen_at is not null and r.bank_status <> 'VERIFIED'
            and not exists (select 1 from payroll_hold h where h.payroll_record_id = r.id and h.hold_kind = 'PAYMENT_SAFETY_BLOCK')`,
        [run.id],
      ),
    ).toBe(0);
    // A fault in the next chunk rolls that chunk back whole: no record of it frozen, no hold, no audit, no lock.
    await h.db.query(`create function zz_chunk_fault() returns trigger language plpgsql as $$ begin raise exception 'synthetic chunk fault' using errcode = '23514'; end $$`);
    await h.db.query(`create trigger zz_chunk_fault before insert on payroll_hold for each row execute function zz_chunk_fault()`);
    try {
      await expect(processService(h.pool, await procGrant(), run.id, { expectedVersion: 1 }, { chunkSize: 3 })).rejects.toThrow(/synthetic chunk fault/);
    } finally {
      await h.db.query(`drop trigger zz_chunk_fault on payroll_hold`);
      await h.db.query(`drop function zz_chunk_fault()`);
    }
    expect(await count(`select count(*)::int as n from payroll_record where run_id = $1 and frozen_at is not null`, [run.id])).toBe(3);
    expect(await count(`select count(*)::int as n from audit_event where record_key = $1 and action in ('PROCESS_CHUNK', 'PROCESS')`, [run.id])).toBe(1);
    expect((await getRun(h, processor, run.id)).state).toBe('APPROVED');
    // A lock written directly while records are still unfrozen is refused by the database.
    await h.db.query('begin');
    try {
      await h.db.query(`update business_transaction set state = 'PROCESSED_LOCKED' where id = (select transaction_id from payroll_run where id = $1)`, [run.id]);
      await expect(h.db.query(`update payroll_run set state = 'PROCESSED_LOCKED', processed_at = now(), lock_version = 1 where id = $1`, [run.id])).rejects.toThrow(
        /freezes every payroll record/,
      );
    } finally {
      await h.db.query('rollback');
    }
    // Resumed: it finishes, then locks with the processing audit.
    const done = await processService(h.pool, await procGrant(), run.id, { expectedVersion: 1 }, { chunkSize: 3 });
    expect(done).toMatchObject({ state: 'PROCESSED_LOCKED', lockVersion: 1, replayed: false, progress: { processing: { frozen: 7, chunks: 3, complete: true } } });
    expect(await count(`select count(*)::int as n from audit_event where record_key = $1 and action = 'PROCESS_CHUNK'`, [run.id])).toBe(3);
    const audit = await h.one<{ after_values: { operational: Record<string, unknown>; amount: { totals: { net: string }[] } } }>(
      `select after_values from audit_event where record_key = $1 and action = 'PROCESS'`,
      [run.id],
    );
    expect(audit.after_values.operational).toMatchObject({ records: 7, chunks: 3, safetyBlocks: 7, bankStatus: { UNVERIFIED: 4, MISSING: 3 } });
    expect(JSON.stringify(audit.after_values.operational)).not.toContain('90300');
    expect(audit.after_values.amount.totals[0]!.net).toBe('90300.0000');
    // Every payable record has exactly one automatic hold; no record was frozen twice.
    expect(await count(`select count(*)::int as n from payroll_hold where run_id = $1`, [run.id])).toBe(7);
    expect((await chunks(run.id, 'PROCESS')).map((x) => x.records)).toEqual([3, 3, 1]);
  });

  it('serialises two connections on the run: concurrent continuations never calculate a member twice', async () => {
    const run = await createRun(h, preparer, periods['2026-03']!, { departmentIds: [dept] });
    const tx = (await h.one<{ transaction_id: string }>(`select transaction_id from payroll_run where id = $1`, [run.id])).transaction_id;
    // A second connection holds the run's transaction lock, as another request in the middle of a chunk would.
    const holder: pg.PoolClient = await h.pool.connect();
    try {
      await holder.query(`select pg_advisory_lock(hashtextextended('bt:' || $1, 0))`, [tx]);
      const g = await prepGrant();
      const a = calculateRun(h.pool, g, run.id, { expectedVersion: run.version }, { chunkSize: 2 });
      const b = calculateRun(h.pool, g, run.id, { expectedVersion: run.version }, { chunkSize: 2 });
      // Both requests wait on the lock before touching anything.
      for (let i = 0; i < 100; i++) {
        const waiting = await count(
          `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and wait_event = 'advisory'`,
          [],
        );
        if (waiting >= 2) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await holder.query(`select pg_advisory_unlock(hashtextextended('bt:' || $1, 0))`, [tx]);
      const results = await Promise.all([a, b]);
      expect(results.map((x) => x.state)).toEqual(['CALCULATED', 'CALCULATED']);
      expect(results.map((x) => x.replayed).sort()).toEqual([false, true]);
    } finally {
      await holder.query(`select pg_advisory_unlock_all()`).catch(() => undefined);
      holder.release();
    }
    expect(await count(`select count(*)::int as n from payroll_record where run_id = $1`, [run.id])).toBe(7);
    const c = await chunks(run.id, 'CALCULATE');
    expect(c.reduce((n, x) => n + x.records, 0)).toBe(7);
    expect(c.map((x) => x.sequence)).toEqual(c.map((_, i) => i + 1));
    // The calculation start is audited once.
    expect(await count(`select count(*)::int as n from audit_event where record_key = $1 and action = 'CALCULATION_STARTED'`, [run.id])).toBe(1);
    // The member index refuses a second live run of the month for these employees even through the database.
    await expect(
      withTransaction(h.pool, async (q) => {
        await q.query(`update payroll_run_member set live = false where lineage_id = $1`, [run.id]);
      }),
    ).rejects.toThrow(/leave the live scope only when their run is cancelled/);
  });
});
