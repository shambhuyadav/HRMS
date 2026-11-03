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
import { writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
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
            case when r.effective_from > now() then 'SCHEDULED'
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
    }>(
      `select id, revision, event_type, channel, recipient_selector, template_id, template_code, template_revision, lead_minutes, retry_ceiling,
              optional_event, active, effective_from, effective_to
         from notification_rule where company_id = $1 and code = $2 order by revision desc for update`,
      [grant.companyId, code],
    )
  ).rows;
  const latest = revisions[0];
  if (!latest) throw notFound();
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

  // The superseded revision ends exactly when the new one starts (an end already earlier is kept).
  await tx.query(
    `update notification_rule set effective_to = $3::timestamptz, updated_by = $4
      where company_id = $1 and id = $2 and (effective_to is null or effective_to > $3::timestamptz)`,
    [grant.companyId, latest.id, input.effectiveFrom, grant.userId],
  );
  const rule = (
    await tx.query<{ id: string; revision: number; effective_from: Date }>(
      `insert into notification_rule (company_id, code, revision, event_type, channel, recipient_selector, template_code, template_revision, template_id,
                                      lead_minutes, retry_ceiling, optional_event, effective_from, active, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::timestamptz, $14, $15, $15)
       returning id, revision, effective_from`,
      [
        grant.companyId,
        code,
        latest.revision + 1,
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
  return { id: rule.id, code, revision: rule.revision, templateRevision, active, effectiveFrom: rule.effective_from.toISOString(), status: 'SCHEDULED' as const };
}
