// No outbox topic is dropped by accident (FR-061, FR-084, DF12): every topic the code enqueues has a describer, or an entry
// in TOPICS_WITHOUT_NOTICE saying why not. And migration 0092 gives a company that already exists the catalogue a new company
// is provisioned with (B5, I-60), keeping every recipient selector an earlier migration allowed. Synthetic data only.
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../../../../db/migrate.js';
import { startEmptyTestDatabase, type TestDatabase } from '../../../../../db/tests/test-database.js';
import { provisionCompany } from '../access/provision.js';
import { MODULE_EVENT_DESCRIBERS } from '../events-registry.js';
import { EVENT_NOTICE_CATALOGUE, TOPICS_WITHOUT_NOTICE } from './catalogue.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = join(HERE, '..', '..');

async function sources(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sources(path)));
    else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.') && !entry.name.includes('.fixtures.')) found.push(path);
  }
  return found;
}

/** Every way the code names an outbox topic: enqueueEvent's `topic:`, payroll's emit helpers, training's map and the scanner's statement. */
const TOPIC_PATTERNS = [
  /\btopic:\s*'([a-z_]+(?:\.[a-z_]+)+)'/g,
  /\bemit(?:Once)?\(\s*tx,\s*[^,]+,\s*'([a-z_]+(?:\.[a-z_]+)+)'/g,
  /^\s+[A-Z_]+:\s*'(training\.[a-z_]+)',?$/gm,
  /insert into outbox_event[^`]*?select \$1, '([a-z_]+(?:\.[a-z_]+)+)'/g,
];

async function enqueuedTopics(): Promise<Set<string>> {
  const topics = new Set<string>();
  for (const file of await sources(SOURCE_ROOT)) {
    const text = await readFile(file, 'utf8');
    for (const pattern of TOPIC_PATTERNS) for (const m of text.matchAll(pattern)) topics.add(m[1]!);
  }
  return topics;
}

describe('every enqueued topic is described or says why not (FR-061)', () => {
  it('no topic is consumed without effect by accident', async () => {
    const topics = await enqueuedTopics();
    // The scan really sees each way of naming a topic.
    for (const known of ['leave.submitted', 'expense.payment_status', 'payroll_hold.assigned', 'training.nominated', 'storage.scan_quarantined']) expect([...topics]).toContain(known);

    const dispatcher = await readFile(join(HERE, 'dispatcher.ts'), 'utf8');
    const described = new Set([...[...dispatcher.matchAll(/\bcase '([a-z_]+(?:\.[a-z_]+)+)':/g)].map((m) => m[1]!), ...Object.keys(MODULE_EVENT_DESCRIBERS)]);
    const dropped = [...topics].filter((t) => !described.has(t)).sort();
    expect(dropped).toEqual(Object.keys(TOPICS_WITHOUT_NOTICE).sort());
  });

  it('each stays-dropped topic gives its reason and has no describer', () => {
    for (const [topic, reason] of Object.entries(TOPICS_WITHOUT_NOTICE)) {
      expect(reason.length, topic).toBeGreaterThan(20);
      expect(MODULE_EVENT_DESCRIBERS[topic], topic).toBeUndefined();
    }
  });

  it('the catalogue is mandatory, its wording uses only its placeholders, and none names a confidential value (DF12, CR-007)', () => {
    for (const n of EVENT_NOTICE_CATALOGUE) {
      expect(n.optional, n.code).toBe(false);
      const used = [...`${n.subject} ${n.body}`.matchAll(/\{\{\s*([a-zA-Z][a-zA-Z0-9]*)\s*\}\}/g)].map((m) => m[1]!);
      expect([...new Set(used)].sort(), n.code).toEqual([...n.placeholders].sort());
      for (const p of n.placeholders) expect(p, n.code).not.toMatch(/amount|percent|reason|purpose|merchant|bank|account|evidence|receipt|salary|^file/i);
    }
  });
});

describe('migration 0092 on a database that already holds a company (I-60)', () => {
  let old: TestDatabase | undefined;
  let db: pg.Client;
  let company: string;
  let customised: string;
  let selectorsBefore: string;

  const rows = async (code: string) =>
    (
      await db.query<{ event_type: string; recipient_selector: string; optional_event: boolean; active: boolean; in_force: boolean; subject_template: string | null; body_template: string; approved_placeholders: string[] }>(
        `select r.event_type, r.recipient_selector, r.optional_event, r.active, r.effective_from <= now() and r.effective_to is null as in_force,
                t.subject_template, t.body_template, t.approved_placeholders
           from notification_rule r join notification_template t on t.company_id = r.company_id and t.id = r.template_id
          where r.company_id = $1 and r.code = $2`,
        [company, code],
      )
    ).rows;

  beforeAll(async () => {
    const empty = await startEmptyTestDatabase();
    if (!empty) return; // only TEST_DATABASE_URL is set: this run cannot create databases
    old = empty;
    db = old.client;
    await migrate(db, { before: '0092' });
    company = (await db.query<{ id: string }>(`insert into company (code, name, active) values ('UPGRADE', 'Upgrade check', true) returning id`)).rows[0]!.id;
    // A company whose rule was already reworded keeps its wording: the migration adds what is missing and changes nothing.
    customised = EVENT_NOTICE_CATALOGUE.find((n) => n.selector === 'SUBJECT_EMPLOYEE')!.code;
    const template = (
      await db.query<{ id: string }>(
        `insert into notification_template (company_id, code, revision, language, channel, subject_template, body_template, approved_placeholders, active)
         values ($1, $2, 1, 'en', 'IN_APP', 'Company wording', 'Company wording', '{}', true) returning id`,
        [company, customised],
      )
    ).rows[0]!.id;
    await db.query(
      `insert into notification_rule (company_id, code, revision, event_type, channel, recipient_selector, template_code, template_revision, template_id, optional_event, effective_from, active)
       values ($1, $2, 1, $2, 'IN_APP', 'SUBJECT_EMPLOYEE', $2, 1, $3, false, now(), true)`,
      [company, customised, template],
    );
    selectorsBefore = (await db.query<{ def: string }>(`select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'notification_rule'::regclass and conname = 'notification_rule_recipient_selector_check'`)).rows[0]!.def;
    await migrate(db);
  });

  afterAll(async () => {
    await old?.stop();
  });

  it('adds every catalogue rule, in force and mandatory, with the wording new companies get', async () => {
    if (!old) return;
    expect(EVENT_NOTICE_CATALOGUE.length).toBeGreaterThan(0);
    for (const n of EVENT_NOTICE_CATALOGUE.filter((x) => x.code !== customised)) {
      expect(await rows(n.code), n.code).toEqual([
        { event_type: n.eventType, recipient_selector: n.selector, optional_event: false, active: true, in_force: true, subject_template: n.subject, body_template: n.body, approved_placeholders: n.placeholders },
      ]);
    }
  });

  it('keeps wording a company already has', async () => {
    if (!old) return;
    expect(await rows(customised)).toMatchObject([{ subject_template: 'Company wording', body_template: 'Company wording' }]);
  });

  it('keeps every selector allowed before and adds the new ones', async () => {
    if (!old) return;
    const def = (await db.query<{ def: string }>(`select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'notification_rule'::regclass and conname = 'notification_rule_recipient_selector_check'`)).rows[0]!.def;
    const list = (text: string) => text.match(/[A-Z][A-Z0-9_]{3,}/g)!.filter((w) => w !== 'CHECK' && w !== 'ARRAY');
    const before = list(selectorsBefore);
    expect(before).toEqual(expect.arrayContaining(['ASSIGNED_REVIEWER', 'SUBJECT_EMPLOYEE', 'SUBJECT_MANAGER', 'BENEFICIARY_USER', 'COMPANY_CELEBRATION_AUDIENCE', 'FALLBACK_REVIEWERS', 'DOCUMENT_READERS', 'POLICY_MANAGERS']));
    expect(list(def).sort()).toEqual([...before, 'BIOMETRIC_SUPPORT', 'GRANT_APPROVERS', 'PROPOSER_OR_MANAGER'].sort());
  });

  it('provisioning the company afterwards duplicates nothing', async () => {
    if (!old) return;
    const approver = (await db.query<{ id: string }>(`insert into user_account (account_key, active) values ('upgrade.approver', true) returning id`)).rows[0]!.id;
    await provisionCompany(db, { companyId: company, approvedBy: approver, effectiveFrom: '2026-01-01' });
    for (const n of EVENT_NOTICE_CATALOGUE) expect((await rows(n.code)).length, n.code).toBe(1);
  });
});
