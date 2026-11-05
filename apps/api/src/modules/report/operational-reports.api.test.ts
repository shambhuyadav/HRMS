// FR-093 and section 11.2's operational outputs: the notification delivery log, upcoming celebrations, and the biometric sync and
// exception reports (additions-9; decisions-10). Each under its own export right, reconciling with the list it exports, and
// never holding a message, a payload, a birth date, a birth year, an age, a credential or a configuration value. Column sets
// await the owner's samples (I-40 item 12); these tests hold what the rows mean. Synthetic data only.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { SYSTEM_ACTOR_ID } from '../../audit/actors.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { runCelebrations } from '../notification/dispatcher.js';
import { csvTable } from './csv.fixtures.js';
import { processReportQueue } from './service.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let today: string;

const cells = (line: string) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1]!.replace(/""/g, '"'));

/** Generates a report and reads it as rows keyed by column header. */
async function report(a: TestActor, reportCode: string, filters: object = {}) {
  const requested = await h.call(a, 'POST', '/v1/reports', { reportCode, filters });
  expect(requested.statusCode, requested.body).toBe(202);
  await processReportQueue(h.pool);
  const file = await h.call(a, 'GET', `/v1/reports/${requested.json().id}/download`);
  expect(file.statusCode, file.body).toBe(200);
  const [header, ...rows] = csvTable(file.body).trimEnd().split('\r\n').map(cells);
  return { body: file.body, header: header!, rows: rows.map((row) => Object.fromEntries(header!.map((column, i) => [column, row[i]!]))) };
}
const refusal = async (a: TestActor, reportCode: string, filters: object = {}) => {
  const res = await h.call(a, 'POST', '/v1/reports', { reportCode, filters });
  return [res.statusCode, res.json().error];
};
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  today = (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [A.id])).d;
});

afterAll(async () => {
  await h?.stop();
});

describe('notification delivery log (section 11.2; FR-093; DF12; BR-034)', () => {
  let support: TestActor;
  let readOnly: TestActor;
  let recipient: TestActor;
  const DELIVERY = '/v1/notifications/delivery';
  const FAILED = '/v1/notifications/delivery/failed-events';

  async function notice(category: string, state: 'DELIVERED' | 'SUPPRESSED' | 'FAILED', failure: string | null, occurredAt = 'now()') {
    const id = (
      await h.one<{ id: string }>(
        `insert into notification (company_id, recipient_user_id, category, state, channel, idempotency_key, body, title, occurred_at)
         values ($1, $2, $3, $4, 'IN_APP', $5, 'SECRET-MESSAGE body', 'SECRET-MESSAGE title', ${occurredAt}) returning id`,
        [A.id, recipient.user, category, state, uniq('report-log:')],
      )
    ).id;
    await h.db.query(`insert into notification_delivery_attempt (company_id, notification_id, attempt_number, outcome, outcome_at, failure_code) values ($1, $2, 1, $3, now(), $4)`, [A.id, id, state, failure]);
    return id;
  }
  async function failedEvent(gaveUp: boolean) {
    return (
      await h.one<{ id: string }>(
        `insert into outbox_event (company_id, topic, aggregate_id, dedupe_key, payload, attempts, last_error, failed_at, next_attempt_at)
         values ($1, 'test.report_failing', $2, $3, '{"secret":"SECRET-PAYLOAD"}', 4, 'TypeError', ${gaveUp ? 'now()' : 'null'}, ${gaveUp ? 'null' : `now() + interval '1 hour'`}) returning id::text as id`,
        [A.id, randomUUID(), uniq('report-failing:')],
      )
    ).id;
  }

  beforeAll(async () => {
    support = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { extra: ['notification.export.operational'] });
    readOnly = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
    recipient = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
  });

  it('needs its own export right, an unrestricted company scope and a period; the read right opens only the lists', async () => {
    const period = { from: today, to: today };
    expect(await refusal(readOnly, 'NOTIFICATION_DELIVERY', period)).toEqual([403, 'FORBIDDEN']);
    expect(await refusal(hr, 'NOTIFICATION_DELIVERY', period)).toEqual([403, 'FORBIDDEN']);
    expect(await refusal(support, 'NOTIFICATION_DELIVERY')).toEqual([422, 'PERIOD_REQUIRED']);
    expect(await refusal(support, 'NOTIFICATION_DELIVERY', { ...period, status: 'LOST' })).toEqual([422, 'INVALID_FILTER']);
    const filtered = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { extra: ['notification.export.operational'], departmentFilter: A.dept });
    expect((await refusal(filtered, 'NOTIFICATION_DELIVERY', period))[0]).toBe(403);
  });

  it('holds what the two lists hold for the same period and status, with attempts and failure, and never a message or payload', async () => {
    const delivered = await notice('REPORT_ALPHA', 'DELIVERED', null);
    const failed = await notice('REPORT_BETA', 'FAILED', 'MISSING_PLACEHOLDER');
    const suppressed = await notice('REPORT_ALPHA', 'SUPPRESSED', 'RECIPIENT_NOT_ELIGIBLE');
    const gaveUp = await failedEvent(true);
    const retrying = await failedEvent(false);

    const period = `from=${today}&to=${today}`;
    const all = await report(support, 'NOTIFICATION_DELIVERY', { from: today, to: today });
    const listed = (await h.call(support, 'GET', `${DELIVERY}?${period}`)).json().total as number;
    const listedFailed = (await h.call(support, 'GET', `${FAILED}?${period}`)).json().total as number;
    expect(all.rows).toHaveLength(listed + listedFailed);
    const byId = new Map(all.rows.map((r) => [r['Record id'], r]));
    expect(byId.get(failed)).toMatchObject({ Source: 'NOTIFICATION', Event: 'REPORT_BETA', Channel: 'IN_APP', Attempts: '1', Outcome: 'FAILED', Failure: 'MISSING_PLACEHOLDER' });
    expect(byId.get(failed)!['Recipient account']).toMatch(/^user\./);
    expect(byId.get(gaveUp)).toMatchObject({ Source: 'DISPATCH', Event: 'test.report_failing', Attempts: '4', Outcome: 'FAILED', Failure: 'TypeError', 'Recipient account': '' });
    expect(byId.get(retrying)).toMatchObject({ Source: 'DISPATCH', Outcome: 'RETRYING' });
    expect(all.body).not.toContain('SECRET-MESSAGE');
    expect(all.body).not.toContain('SECRET-PAYLOAD');

    const onlyFailed = await report(support, 'NOTIFICATION_DELIVERY', { from: today, to: today, status: 'FAILED' });
    const failedLists =
      ((await h.call(support, 'GET', `${DELIVERY}?${period}&state=FAILED`)).json().total as number) + ((await h.call(support, 'GET', `${FAILED}?${period}&state=FAILED`)).json().total as number);
    expect(onlyFailed.rows).toHaveLength(failedLists);
    expect(onlyFailed.rows.map((r) => r['Record id'])).toEqual(expect.arrayContaining([failed, gaveUp]));
    expect(onlyFailed.rows.map((r) => r['Record id'])).not.toContain(delivered);

    // An event type names notifications; a failed dispatch has none, as its list takes no such filter.
    const alpha = await report(support, 'NOTIFICATION_DELIVERY', { from: today, to: today, category: 'REPORT_ALPHA' });
    expect(alpha.rows.map((r) => r['Record id']).sort()).toEqual([delivered, suppressed].sort());
  });

  it('applies the period in company time, on the lists and the export alike, and refuses a reversed one', async () => {
    const yesterday = addDays(today, -1);
    const old = await notice('REPORT_PERIOD', 'DELIVERED', null, `((now() at time zone 'UTC') - interval '3 days') at time zone 'UTC'`);
    const shown = await notice('REPORT_PERIOD', 'DELIVERED', null);
    const inPeriod = await report(support, 'NOTIFICATION_DELIVERY', { from: yesterday, to: today, category: 'REPORT_PERIOD' });
    expect(inPeriod.rows.map((r) => r['Record id'])).toEqual([shown]);
    const listedIn = (await h.call(support, 'GET', `${DELIVERY}?category=REPORT_PERIOD&from=${yesterday}&to=${today}`)).json();
    expect(listedIn.items.map((r: { id: string }) => r.id)).toEqual([shown]);
    const listedOut = (await h.call(support, 'GET', `${DELIVERY}?category=REPORT_PERIOD&to=${addDays(today, -2)}`)).json();
    expect(listedOut.items.map((r: { id: string }) => r.id)).toEqual([old]);
    for (const url of [DELIVERY, FAILED]) {
      const reversed = await h.call(support, 'GET', `${url}?from=${today}&to=${yesterday}`);
      expect([reversed.statusCode, reversed.json().error]).toEqual([422, 'INVALID_PERIOD']);
      expect((await h.call(support, 'GET', `${url}?from=yesterday`)).statusCode).toBe(400);
    }
    expect(await refusal(support, 'NOTIFICATION_DELIVERY', { from: today, to: yesterday })).toEqual([422, 'INVALID_PERIOD']);
  });

  it('stays in its company', async () => {
    const B = await h.makeCompany();
    const elsewhere = await h.actor(B, 'SYSTEM_ADMINISTRATOR', { extra: ['notification.export.operational'] });
    expect((await report(elsewhere, 'NOTIFICATION_DELIVERY', { from: today, to: today })).rows).toEqual([]);
  });
});

describe('upcoming celebration events (FR-093; section 11.2; DF12; BR-032)', () => {
  let exporter: TestActor;
  const FAR = () => ({ from: today, to: addDays(today, 60) });

  async function person(name: string, dateOfBirth: string | null, opts: { joiningDate?: string; departmentId?: string; publish?: string[]; status?: string } = {}) {
    const res = await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { displayName: name, ...(opts.joiningDate ? { joiningDate: opts.joiningDate } : {}), ...(opts.departmentId ? { departmentId: opts.departmentId } : {}) }));
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().id as string;
    await h.setStatus(A, id, 'ACTIVE_CONFIRMED');
    await h.db.query(`update employee set date_of_birth = $2 where id = $1`, [id, dateOfBirth]);
    const actor = await h.actor(A, 'EMPLOYEE', { employeeId: id });
    for (const eventType of opts.publish ?? ['BIRTHDAY']) {
      expect((await h.call(actor, 'PUT', '/v1/me/notification-preferences', { eventType, publishCelebration: true })).statusCode).toBe(200);
    }
    if (opts.status) await h.setStatus(A, id, opts.status);
    return { id, actor };
  }
  /** A birth date whose next occurrence is `daysAhead` from today, in 1990. */
  const bornSoon = (daysAhead: number) => `1990${addDays(today, daysAhead).slice(4)}`;

  beforeAll(async () => {
    exporter = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['celebration.export.operational'] });
  });

  it('needs its own grant: HR by default, an employee and a manager are refused', async () => {
    expect(await refusal(hr, 'UPCOMING_CELEBRATIONS', FAR())).toEqual([403, 'FORBIDDEN']);
    const self = await person(uniq('Synthetic Refused '), null);
    expect(await refusal(self.actor, 'UPCOMING_CELEBRATIONS', FAR())).toEqual([403, 'FORBIDDEN']);
    expect(await refusal(await h.actor(A, 'REPORTING_MANAGER'), 'UPCOMING_CELEBRATIONS', FAR())).toEqual([403, 'FORBIDDEN']);
    expect(await refusal(exporter, 'UPCOMING_CELEBRATIONS')).toEqual([422, 'PERIOD_REQUIRED']);
  });

  it('lists opted-in active employees only, with name, department, event and date: never a birth date, birth year, age or code', async () => {
    const shown = uniq('Synthetic Shown ');
    const quiet = uniq('Synthetic Quiet ');
    const gone = uniq('Synthetic Gone ');
    const person1 = await person(shown, bornSoon(10));
    // Opted in and then out: a saved preference that says no, and one never saved.
    const optedOut = await person(quiet, bornSoon(11));
    expect((await h.call(optedOut.actor, 'PUT', '/v1/me/notification-preferences', { eventType: 'BIRTHDAY', publishCelebration: false })).statusCode).toBe(200);
    const neverSaved = uniq('Synthetic Never Saved ');
    await person(neverSaved, bornSoon(13), { publish: [] });
    await person(gone, bornSoon(12), { status: 'INACTIVE_SEPARATED' });
    const code = (await h.one<{ employee_code: string }>(`select employee_code from employee where id = $1`, [person1.id])).employee_code;

    const file = await report(exporter, 'UPCOMING_CELEBRATIONS', FAR());
    expect(file.header).toEqual(['Observed on', 'Event', 'Name', 'Department']);
    expect(file.rows.find((r) => r.Name === shown)).toEqual({ 'Observed on': addDays(today, 10), Event: 'BIRTHDAY', Name: shown, Department: expect.any(String) });
    expect(file.rows.map((r) => r.Name)).not.toContain(quiet);
    expect(file.rows.map((r) => r.Name)).not.toContain(neverSaved);
    expect(file.rows.map((r) => r.Name)).not.toContain(gone);
    expect(csvTable(file.body)).not.toContain('1990');
    expect(csvTable(file.body)).not.toContain(bornSoon(10));
    expect(csvTable(file.body)).not.toContain(code);
    expect(file.header.join(' ')).not.toMatch(/birth|age|year/i);
  });

  it('a year cannot be probed: a past period holds nothing, whatever the birth or joining date', async () => {
    const name = uniq('Synthetic Probe ');
    await person(name, '1990-06-15', { joiningDate: '2026-01-05', publish: ['BIRTHDAY', 'WORK_ANNIVERSARY'] });
    for (const from of ['1990-01-01', '2020-01-01']) {
      const past = await report(exporter, 'UPCOMING_CELEBRATIONS', { from, to: addDays(from, 364) });
      expect(past.rows.map((r) => r.Name)).not.toContain(name);
    }
  });

  it('follows runCelebrations: 29 February on 28 February in a non-leap year, the first year of service left out, and the same people that day', async () => {
    let year = Number(today.slice(0, 4));
    while (`${year}-02-28` < today || (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0) year++;
    const leap = uniq('Synthetic Leap ');
    await person(leap, '1992-02-29');
    const day = `${year}-02-28`;
    const onThatDay = await report(exporter, 'UPCOMING_CELEBRATIONS', { from: day, to: day });
    expect(onThatDay.rows.find((r) => r.Name === leap)).toMatchObject({ 'Observed on': day, Event: 'BIRTHDAY' });

    await runCelebrations(h.pool, A.id, day);
    const published = (await h.db.query<{ name: string }>(`select data->>'employeeName' as name from notification_event where company_id = $1 and occurrence_date = $2::date and event_type = 'BIRTHDAY'`, [A.id, day])).rows.map((e) => e.name);
    expect(published.sort()).toEqual(onThatDay.rows.filter((r) => r.Event === 'BIRTHDAY').map((r) => r.Name).sort());

    const joiner = uniq('Synthetic Joiner ');
    const soon = addDays(today, 5);
    await person(joiner, null, { joiningDate: soon, publish: ['WORK_ANNIVERSARY'] });
    const thisYear = await report(exporter, 'UPCOMING_CELEBRATIONS', { from: today, to: addDays(today, 30) });
    expect(thisYear.rows.map((r) => r.Name)).not.toContain(joiner);
    const nextYear = await report(exporter, 'UPCOMING_CELEBRATIONS', { from: addDays(soon, 360), to: addDays(soon, 370) });
    expect(nextYear.rows.find((r) => r.Name === joiner)?.Event).toBe('WORK_ANNIVERSARY');
  });

  it('stays in the requester’s row scope and refuses a period beyond its technical bound', async () => {
    const finance = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['celebration.export.operational'], departmentFilter: A.financeDept });
    const inFinance = uniq('Synthetic Finance ');
    const elsewhere = uniq('Synthetic Engineering ');
    await person(inFinance, bornSoon(20), { departmentId: A.financeDept });
    await person(elsewhere, bornSoon(21), { departmentId: A.dept });
    const names = (await report(finance, 'UPCOMING_CELEBRATIONS', FAR())).rows.map((r) => r.Name);
    expect(names).toContain(inFinance);
    expect(names).not.toContain(elsewhere);
    expect(await refusal(exporter, 'UPCOMING_CELEBRATIONS', { from: today, to: addDays(today, 366) })).toEqual([422, 'PERIOD_TOO_LONG']);
  });
});

describe('biometric sync and exceptions (FR-087; FR-093; section 11.2)', () => {
  let admin: TestActor;
  let profile: string;
  let run: string;

  beforeAll(async () => {
    admin = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { extra: ['biometric.export.operational', 'biometric.read.operational', 'biometric.sync_run.operational'] });
    profile = (
      await h.one<{ id: string }>(
        `insert into biometric_profile (company_id, code, name, request_config_reference, auth_reference, provider_timezone, pagination_mode, schedule_reference, lookback_minutes, active)
         values ($1, 'SYNTHETIC_DEVICE', 'Synthetic device', 'SECRET-CONFIG-REF', 'SECRET-AUTH-REF', 'Asia/Kolkata', 'CURSOR', 'SECRET-SCHEDULE-REF', 60, true) returning id`,
        [A.id],
      )
    ).id;
    const mapping = (
      await h.one<{ id: string }>(
        `insert into biometric_mapping_revision (company_id, profile_id, revision, effective_from, dedupe_strategy, timestamp_rule, created_by) values ($1, $2, 3, now() - interval '30 days', 'FINGERPRINT', 'ISO_WITH_OFFSET', $3) returning id`,
        [A.id, profile, SYSTEM_ACTOR_ID],
      )
    ).id;
    const insertRun = async (state: string, failure: string | null, counts: [number, number, number, number]) =>
      (
        await h.one<{ id: string }>(
          `insert into biometric_sync_run (company_id, profile_id, mapping_revision_id, window_start, window_end, starting_checkpoint_reference, committed_checkpoint_reference, source_observation_count,
                                           accepted_count, duplicate_count, rejected_count, quarantined_count, state, failure_code, finished_at)
           values ($1, $2, $3, now() - interval '2 hours', now() - interval '1 hour', 'SECRET-START', 'SECRET-CHECKPOINT', $4, $5, $6, $7, $8, $9, $10, now()) returning id`,
          [A.id, profile, mapping, counts[0] + counts[1] + counts[2] + counts[3], counts[0], counts[1], counts[2], counts[3], state, failure],
        )
      ).id;
    run = await insertRun('PARTIAL', 'PROVIDER_TIMEOUT', [5, 2, 1, 2]);
    await insertRun('COMPLETED', null, [4, 0, 0, 0]);
    const observe = (index: number, outcome: string, failure: string | null, evidence: object | null) =>
      h.db.query(`insert into biometric_run_observation (company_id, run_id, observation_index, source_event_key, fingerprint, outcome, failure_code, source_evidence) values ($1, $2, $3, $4, $5, $6, $7, $8)`, [
        A.id,
        run,
        index,
        `SYNTHETIC-KEY-${index}`,
        'SECRET-FINGERPRINT',
        outcome,
        failure,
        evidence,
      ]);
    await observe(1, 'ACCEPTED', null, null);
    await observe(2, 'REJECTED', 'MAPPING_FAILED', null);
    await observe(3, 'QUARANTINED', 'UNKNOWN_EMPLOYEE', { employeeKey: 'SECRET-EVIDENCE' });
  });

  it('needs its own export right and an unrestricted company scope', async () => {
    const reader = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { extra: ['biometric.read.operational'] });
    expect(await refusal(reader, 'BIOMETRIC_SYNC')).toEqual([403, 'FORBIDDEN']);
    expect(await refusal(reader, 'BIOMETRIC_SYNC_EXCEPTIONS')).toEqual([403, 'FORBIDDEN']);
    expect(await refusal(hr, 'BIOMETRIC_SYNC')).toEqual([403, 'FORBIDDEN']);
    const filtered = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { extra: ['biometric.export.operational'], departmentFilter: A.dept });
    expect((await refusal(filtered, 'BIOMETRIC_SYNC'))[0]).toBe(403);
  });

  it('a run shows its range, mapping revision, every count and its failure, reconciling with GET /biometric/runs, and no configuration', async () => {
    const all = await report(admin, 'BIOMETRIC_SYNC');
    const listed = (await h.call(admin, 'GET', '/v1/biometric/runs')).json();
    expect(all.rows).toHaveLength(listed.total);
    expect(all.rows.find((r) => r['Run id'] === run)).toMatchObject({
      Profile: 'SYNTHETIC_DEVICE',
      'Mapping revision': '3',
      State: 'PARTIAL',
      'Source observations': '10',
      Unique: '8',
      Duplicates: '2',
      Accepted: '5',
      Rejected: '1',
      Quarantined: '2',
      Failure: 'PROVIDER_TIMEOUT',
    });
    expect(all.rows.find((r) => r['Run id'] === run)!['Range start (company time)']).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(all.body).not.toContain('SECRET-');

    const failed = await report(admin, 'BIOMETRIC_SYNC', { status: 'PARTIAL', profileId: profile, from: today, to: today });
    expect(failed.rows.map((r) => r['Run id'])).toEqual([run]);
    expect((await h.call(admin, 'GET', `/v1/biometric/runs?state=PARTIAL&profileId=${profile}&from=${today}&to=${today}`)).json().total).toBe(1);
    expect(await refusal(admin, 'BIOMETRIC_SYNC', { status: 'LOST' })).toEqual([422, 'INVALID_FILTER']);
  });

  it('an exception shows its outcome and failure, reconciling with GET /biometric/exceptions, without its source evidence', async () => {
    const all = await report(admin, 'BIOMETRIC_SYNC_EXCEPTIONS', { runId: run });
    const listed = (await h.call(admin, 'GET', `/v1/biometric/exceptions?runId=${run}`)).json();
    expect(all.rows).toHaveLength(listed.total);
    expect(all.rows.map((r) => [r.Observation, r.Outcome, r.Failure, r['Source event key']]).sort()).toEqual([
      ['2', 'REJECTED', 'MAPPING_FAILED', 'SYNTHETIC-KEY-2'],
      ['3', 'QUARANTINED', 'UNKNOWN_EMPLOYEE', 'SYNTHETIC-KEY-3'],
    ]);
    expect(all.body).not.toContain('SECRET-');

    const quarantined = await report(admin, 'BIOMETRIC_SYNC_EXCEPTIONS', { runId: run, status: 'QUARANTINED' });
    expect(quarantined.rows.map((r) => r.Observation)).toEqual(['3']);
    expect(await refusal(admin, 'BIOMETRIC_SYNC_EXCEPTIONS', { status: 'ACCEPTED' })).toEqual([422, 'INVALID_FILTER']);
    expect(await refusal(admin, 'BIOMETRIC_SYNC_EXCEPTIONS', { from: today, to: today })).toEqual([422, 'FILTER_NOT_SUPPORTED']);
  });
});
