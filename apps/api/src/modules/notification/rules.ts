// Notification rule configuration (FR-085, FR-061; BR-034; DF12; CI18). Rules and templates are versioned: a change is
// a new rule revision (and, for new wording, a new template revision) that takes effect only from its configured
// future date, ending the revision it supersedes at that instant, so exactly one revision of a rule is in force at any
// time and an event is never notified twice by one rule. Every change is audited with its reason.
//
// What a change may not do (each needs an owner decision the BRD leaves open, so the revision keeps the previous
// value): change the event, the channel (DF12: in-app only), the recipient selector or escalation timing (FR-061:
// recipients and escalation times need owner approval), the retry ceiling, or the optional flag. New wording may use
// only the placeholders already approved for the template (minimal personal data). A mandatory rule cannot be
// switched off (FR-085: mandatory transaction alerts cannot be opted out unless the owner approves that policy).
//
// C6 "publication and mandatory notification settings require business owner approval" (0133): a revision is proposed, and comes into
// force only once someone other than its author publishes it, before its date; until then the revision in force keeps going and
// nothing ends it. A rejected revision is kept, with its reason, and never comes into force. Who holds the approval is the owner's to say.
import { writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import type { AccessGrant } from '../access/authorize.js';

const PLACEHOLDER = /\{\{\s*([a-zA-Z][a-zA-Z0-9]*)\s*\}\}/g;

export interface RuleRevisionInput {
  expectedRevision: number;
  effectiveFrom: string;
  active?: boolean | undefined;
  subjectTemplate?: string | null | undefined;
  bodyTemplate?: string | undefined;
  reason: string;
}

/** Every revision of every rule in the company, with its template wording and whether it is in force. */
export async function listRules(db: Queryable, grant: AccessGrant, code?: string) {
  const rows = await db.query(
    `select r.id, r.code, r.revision, r.event_type as "eventType", r.channel, r.recipient_selector as "recipientSelector",
            r.optional_event as "optionalEvent", r.active, r.effective_from as "effectiveFrom", r.effective_to as "effectiveTo",
            r.retry_ceiling as "retryCeiling", r.template_code as "templateCode", r.template_revision as "templateRevision",
            t.subject_template as "subjectTemplate", t.body_template as "bodyTemplate", t.approved_placeholders as "approvedPlaceholders",
            r.proposal_reason as "proposalReason", r.decision_reason as "decisionReason",
            case when r.publication_state <> 'PUBLISHED' then r.publication_state
                 when r.effective_from > now() then 'SCHEDULED'
                 when r.effective_to is not null and r.effective_to <= now() then 'SUPERSEDED'
                 else 'IN_FORCE' end as status
       from notification_rule r join notification_template t on t.company_id = r.company_id and t.id = r.template_id
      where r.company_id = $1 and ($2::text is null or r.code = $2)
      order by r.code, r.revision`,
    [grant.companyId, code ?? null],
  );
  return { items: rows.rows };
}

function unapprovedPlaceholder(text: string, approved: readonly string[]): string | null {
  for (const m of text.matchAll(PLACEHOLDER)) if (!approved.includes(m[1]!)) return m[1]!;
  return null;
}

export async function reviseRule(tx: Queryable, grant: AccessGrant, code: string, input: RuleRevisionInput) {
  const revisions = (
    await tx.query<{
      id: string;
      revision: number;
      event_type: string;
      channel: string;
      recipient_selector: string;
      template_id: string;
      template_code: string;
      template_revision: number;
      lead_minutes: number;
      retry_ceiling: number;
      optional_event: boolean;
      active: boolean;
      effective_from: Date;
      effective_to: Date | null;
      publication_state: string;
    }>(
      `select id, revision, event_type, channel, recipient_selector, template_id, template_code, template_revision, lead_minutes, retry_ceiling,
              optional_event, active, effective_from, effective_to, publication_state
         from notification_rule where company_id = $1 and code = $2 order by revision desc for update`,
      [grant.companyId, code],
    )
  ).rows;
  await reassertAccess(tx, grant, 'notification', 'manage_rules', ['operational']);
  // A rejected revision was never part of the rule's history in force: the next change builds on what came before it.
  const latest = revisions.find((r) => r.publication_state !== 'REJECTED');
  if (!latest) throw notFound();
  if (latest.publication_state === 'PROPOSED') throw new HttpError(409, 'REVISION_PENDING', 'A change to this rule is already waiting for approval');
  if (latest.revision !== input.expectedRevision) throw new HttpError(409, 'STALE_VERSION', 'The rule changed; reload and retry');

  const timing = (
    await tx.query<{ future: boolean; after_latest: boolean }>(
      `select $1::timestamptz > now() as future, $1::timestamptz > $2::timestamptz as after_latest`,
      [input.effectiveFrom, latest.effective_from],
    )
  ).rows[0]!;
  if (!timing.future) throw new HttpError(422, 'EFFECTIVE_DATE_NOT_FUTURE', 'A rule change takes effect from a future date only');
  if (!timing.after_latest) throw new HttpError(422, 'EFFECTIVE_DATE_BEFORE_LATEST', 'A rule change must take effect after the latest revision of the rule');

  const active = input.active ?? latest.active;
  if (!active && !latest.optional_event) throw new HttpError(422, 'MANDATORY_RULE', 'A mandatory notification rule cannot be switched off');

  const template = (
    await tx.query<{ language: string; subject_template: string | null; body_template: string; approved_placeholders: string[] }>(
      `select language, subject_template, body_template, approved_placeholders from notification_template where company_id = $1 and id = $2`,
      [grant.companyId, latest.template_id],
    )
  ).rows[0]!;
  const rewording = input.subjectTemplate !== undefined || input.bodyTemplate !== undefined;
  const subject = input.subjectTemplate !== undefined ? input.subjectTemplate : template.subject_template;
  const body = input.bodyTemplate ?? template.body_template;
  if (rewording && subject === template.subject_template && body === template.body_template) {
    throw new HttpError(422, 'NO_CHANGE', 'The wording is unchanged');
  }
  if (!rewording && active === latest.active) throw new HttpError(422, 'NO_CHANGE', 'The revision changes nothing');
  if (body.trim() === '') throw new HttpError(422, 'VALIDATION_FAILED', 'The message body cannot be blank');
  for (const text of [subject ?? '', body]) {
    const bad = unapprovedPlaceholder(text, template.approved_placeholders);
    if (bad) throw new HttpError(422, 'PLACEHOLDER_NOT_APPROVED', 'The wording uses a placeholder that is not approved for this message', { placeholder: bad });
  }

  let templateId = latest.template_id;
  let templateRevision = latest.template_revision;
  if (rewording) {
    const created = (
      await tx.query<{ id: string; revision: number }>(
        `insert into notification_template (company_id, code, revision, language, channel, subject_template, body_template, approved_placeholders, active, created_by, updated_by)
         select $1, $2, coalesce(max(revision), 0) + 1, $3, $4, $5, $6, $7, true, $8, $8
           from notification_template where company_id = $1 and code = $2
         returning id, revision`,
        [grant.companyId, latest.template_code, template.language, latest.channel, subject, body, template.approved_placeholders, grant.userId],
      )
    ).rows[0]!;
    templateId = created.id;
    templateRevision = created.revision;
    await writeAudit(tx, {
      companyId: grant.companyId,
      resource: 'notification_template',
      recordKey: created.id,
      actorUserId: grant.userId,
      actingAssignmentId: grant.assignmentId,
      action: 'CREATE',
      newVersion: 1,
      after: { operational: { code: latest.template_code, revision: created.revision, subjectChanged: subject !== template.subject_template, bodyChanged: body !== template.body_template } },
      reason: input.reason,
    });
  }

  // Numbered after every revision the rule has had, a rejected one included: its number stays its own.
  const rule = (
    await tx.query<{ id: string; revision: number; effective_from: Date }>(
      `insert into notification_rule (company_id, code, revision, event_type, channel, recipient_selector, template_code, template_revision, template_id,
                                      lead_minutes, retry_ceiling, optional_event, effective_from, active, publication_state, proposal_reason, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::timestamptz, $14, 'PROPOSED', $16, $15, $15)
       returning id, revision, effective_from`,
      [
        grant.companyId,
        code,
        revisions[0]!.revision + 1,
        latest.event_type,
        latest.channel,
        latest.recipient_selector,
        latest.template_code,
        templateRevision,
        templateId,
        latest.lead_minutes,
        latest.retry_ceiling,
        latest.optional_event,
        input.effectiveFrom,
        active,
        grant.userId,
        input.reason.trim(),
      ],
    )
  ).rows[0]!;
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'notification_rule',
    recordKey: rule.id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'REVISE',
    newVersion: 1,
    before: { operational: { code, revision: latest.revision, active: latest.active, templateRevision: latest.template_revision } },
    after: { operational: { code, revision: rule.revision, active, templateRevision, effectiveFrom: rule.effective_from.toISOString() } },
    reason: input.reason,
  });
  return { id: rule.id, code, revision: rule.revision, templateRevision, active, effectiveFrom: rule.effective_from.toISOString(), status: 'PROPOSED' as const };
}

/** The changes waiting for a decision, each beside what is in force, for whoever holds the approval. */
export async function listRuleProposals(db: Queryable, grant: AccessGrant) {
  const rows = await db.query(
    `select r.id, r.code, r.revision, r.version, r.event_type as "eventType", r.optional_event as "optionalEvent", r.active, r.effective_from as "effectiveFrom",
            r.proposal_reason as "proposalReason", r.created_by as "proposedBy", u.account_key as "proposedByAccountKey",
            t.subject_template as "subjectTemplate", t.body_template as "bodyTemplate",
            cur.active as "currentActive", cur.subject_template as "currentSubjectTemplate", cur.body_template as "currentBodyTemplate"
       from notification_rule r
       join notification_template t on t.company_id = r.company_id and t.id = r.template_id
       left join user_account u on u.id = r.created_by
       left join lateral (select p.active, pt.subject_template, pt.body_template
                            from notification_rule p join notification_template pt on pt.company_id = p.company_id and pt.id = p.template_id
                           where p.company_id = r.company_id and p.code = r.code and p.publication_state = 'PUBLISHED'
                           order by p.revision desc limit 1) cur on true
      where r.company_id = $1 and r.publication_state = 'PROPOSED'
      order by r.effective_from, r.code`,
    [grant.companyId],
  );
  return { items: rows.rows };
}

interface ProposalRow {
  id: string;
  code: string;
  revision: number;
  version: number;
  created_by: string | null;
  effective_from: Date;
  publication_state: string;
}

/** Locks the rule's revisions as a change does, so a decision and a new change are ordered, and checks who decides. */
async function lockForDecision(tx: Queryable, grant: AccessGrant, id: string, expectedVersion: number): Promise<{ row: ProposalRow; published: ProposalRow | undefined }> {
  const code = (await tx.query<{ code: string }>(`select code from notification_rule where company_id = $1 and id = $2`, [grant.companyId, id])).rows[0]?.code;
  if (!code) throw notFound();
  const revisions = (
    await tx.query<ProposalRow>(
      `select id, code, revision, version, created_by, effective_from, publication_state from notification_rule where company_id = $1 and code = $2 order by revision desc for update`,
      [grant.companyId, code],
    )
  ).rows;
  const row = revisions.find((r) => r.id === id)!;
  if (row.version !== expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The rule changed; reload and retry');
  if (row.publication_state !== 'PROPOSED') throw new HttpError(409, 'INVALID_STATE', 'Only a proposed revision can be decided');
  if (row.created_by === grant.userId) throw new HttpError(403, 'SELF_APPROVAL', 'A rule change cannot be decided by its author');
  await reassertAccess(tx, grant, 'notification', 'approve_rules', ['operational']);
  const { departments, locations, employees } = grant.filters;
  if (grant.scopeKind !== 'COMPANY' || departments.length + locations.length + employees.length > 0) {
    throw new HttpError(403, 'SCOPE_EXCEEDS_ADMINISTRATOR', 'A notification rule applies to the whole company, which is wider than your administrative scope');
  }
  return { row, published: revisions.find((r) => r.publication_state === 'PUBLISHED') };
}

export async function publishRuleRevision(tx: Queryable, grant: AccessGrant, id: string, expectedVersion: number) {
  const { row, published } = await lockForDecision(tx, grant, id, expectedVersion);
  // FR-085 "takes effect only from its configured date"; I-35: never from the past. A date that went by unapproved needs a new proposal.
  const future = (await tx.query<{ future: boolean }>(`select $1::timestamptz > now() as future`, [row.effective_from])).rows[0]!.future;
  if (!future) throw new HttpError(422, 'EFFECTIVE_DATE_NOT_FUTURE', 'The date of this change has passed; reject it and propose a new date');
  // The superseded revision ends exactly when this one starts (an end already earlier is kept).
  if (published) {
    await tx.query(
      `update notification_rule set effective_to = $3::timestamptz, updated_by = $4
        where company_id = $1 and id = $2 and (effective_to is null or effective_to > $3::timestamptz)`,
      [grant.companyId, published.id, row.effective_from, grant.userId],
    );
  }
  await tx.query(`update notification_rule set publication_state = 'PUBLISHED', decided_by = $3, decided_at = now(), updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, id, grant.userId]);
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'notification_rule',
    recordKey: id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'PUBLISH',
    priorVersion: row.version,
    after: { operational: { code: row.code, revision: row.revision, effectiveFrom: row.effective_from.toISOString() } },
  });
  return { id, code: row.code, revision: row.revision, effectiveFrom: row.effective_from.toISOString(), status: 'SCHEDULED' as const };
}

export async function rejectRuleRevision(tx: Queryable, grant: AccessGrant, id: string, expectedVersion: number, reason: string) {
  const { row } = await lockForDecision(tx, grant, id, expectedVersion);
  await tx.query(`update notification_rule set publication_state = 'REJECTED', decided_by = $3, decided_at = now(), decision_reason = $4, updated_by = $3 where company_id = $1 and id = $2`, [
    grant.companyId,
    id,
    grant.userId,
    reason.trim(),
  ]);
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'notification_rule',
    recordKey: id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'REJECT',
    priorVersion: row.version,
    after: { operational: { code: row.code, revision: row.revision } },
    reason,
  });
  return { id, code: row.code, revision: row.revision, status: 'REJECTED' as const };
}
