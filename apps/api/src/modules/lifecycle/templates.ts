// Process templates (FR-015; DB075; F1 "HR-controlled checklist templates with ordered task owners and explicit
// required/optional tasks"). A template is edited as a DRAFT revision whose ordered tasks are replaced as a whole;
// publishing freezes the revision (database guard) and retires the one published before. Employee processes copy
// the tasks of the revision published when they start, so a later revision never rewrites an instance.
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import type { AccessGrant } from '../access/authorize.js';
import { isEligibleReviewer } from '../workflow/engine.js';
import { actorOf, audit } from './common.js';

export interface TemplateTaskInput {
  code: string;
  title: string;
  ownerRoleCode?: string | undefined;
  ownerUserId?: string | undefined;
  required: boolean;
  dueOffsetDays: number;
  evidenceRequired: boolean;
}

interface TemplateRow {
  id: string;
  code: string;
  name: string;
  process_type: string;
  active: boolean;
  version: number;
}

export const COMPLETE_TASK = { resource: 'employee_process', action: 'complete_task', fieldGroup: 'operational' } as const;

async function permissionId(db: Queryable, p: { resource: string; action: string; fieldGroup: string }): Promise<string> {
  return (await db.query<{ id: string }>(`select id from permission where resource = $1 and action = $2 and field_group = $3`, [p.resource, p.action, p.fieldGroup])).rows[0]!.id;
}

/**
 * A task owner must be able to complete it: a company role whose ceiling allows the completion duty, or a user
 * who holds it in an active assignment (the employee's own user is excluded when the process starts).
 */
export async function validateOwner(db: Queryable, companyId: string, owner: { ownerRoleCode?: string | undefined; ownerUserId?: string | undefined }, index?: number) {
  const details = index === undefined ? {} : { task: index + 1 };
  if ((owner.ownerRoleCode === undefined) === (owner.ownerUserId === undefined)) {
    throw new HttpError(422, 'OWNER_REQUIRED', 'Give exactly one owner: a role or a user', details);
  }
  const perm = await permissionId(db, COMPLETE_TASK);
  if (owner.ownerRoleCode !== undefined) {
    const ok = await db.query(
      `select 1 from role r join role_permission rp on rp.company_id = r.company_id and rp.role_id = r.id and rp.permission_id = $3 and rp.effect = 'ALLOW'
        where r.company_id = $1 and r.code = $2 and r.active`,
      [companyId, owner.ownerRoleCode, perm],
    );
    if ((ok.rowCount ?? 0) === 0) throw new HttpError(422, 'INVALID_OWNER', 'That role cannot complete process tasks', { ...details, ownerRoleCode: owner.ownerRoleCode });
    return;
  }
  if (!(await isEligibleReviewer(db, companyId, owner.ownerUserId!, perm, null))) {
    throw new HttpError(422, 'INVALID_OWNER', 'That user cannot complete process tasks in this company', details);
  }
}

async function loadTemplate(db: Queryable, companyId: string, id: string, lock = false): Promise<TemplateRow> {
  const row = (
    await db.query<TemplateRow>(
      `select p.id, p.code, p.name, t.code as process_type, p.active, p.version
         from lifecycle_process p join reference_value t on t.company_id = p.company_id and t.id = p.process_type_id
        where p.company_id = $1 and p.id = $2 ${lock ? 'for update of p' : ''}`,
      [companyId, id],
    )
  ).rows[0];
  if (!row) throw notFound();
  return row;
}

async function revisions(db: Queryable, companyId: string, processId: string) {
  const revs = (
    await db.query<{ id: string; revision: number; state: string; published_at: Date | null; version: number }>(
      `select id, revision, state, published_at, version from lifecycle_process_revision where company_id = $1 and process_id = $2 order by revision`,
      [companyId, processId],
    )
  ).rows;
  const tasks = (
    await db.query<{
      revision_id: string;
      sequence: number;
      code: string;
      title: string;
      owner_role_code: string | null;
      owner_user_id: string | null;
      required: boolean;
      due_offset_days: number;
      evidence_required: boolean;
    }>(
      `select t.revision_id, t.sequence, t.code, t.title, t.owner_role_code, t.owner_user_id, t.required, t.due_offset_days, t.evidence_required
         from lifecycle_process_task t join lifecycle_process_revision r on r.company_id = t.company_id and r.id = t.revision_id
        where t.company_id = $1 and r.process_id = $2 order by t.sequence`,
      [companyId, processId],
    )
  ).rows;
  return revs.map((r) => ({
    revision: r.revision,
    state: r.state,
    publishedAt: r.published_at,
    version: r.version,
    tasks: tasks
      .filter((t) => t.revision_id === r.id)
      .map((t) => ({
        sequence: t.sequence,
        code: t.code,
        title: t.title,
        ownerRoleCode: t.owner_role_code,
        ownerUserId: t.owner_user_id,
        required: t.required,
        dueOffsetDays: t.due_offset_days,
        evidenceRequired: t.evidence_required,
      })),
  }));
}

export async function templateDetail(db: Queryable, grant: AccessGrant, id: string) {
  const t = await loadTemplate(db, grant.companyId, id);
  return { id: t.id, code: t.code, name: t.name, processType: t.process_type, active: t.active, version: t.version, revisions: await revisions(db, grant.companyId, t.id) };
}

export async function listTemplates(db: Queryable, grant: AccessGrant) {
  const rows = await db.query(
    `select p.id, p.code, p.name, t.code as "processType", p.active, p.version,
            (select max(r.revision) from lifecycle_process_revision r where r.company_id = p.company_id and r.process_id = p.id and r.state = 'PUBLISHED') as "publishedRevision",
            (select max(r.revision) from lifecycle_process_revision r where r.company_id = p.company_id and r.process_id = p.id and r.state = 'DRAFT') as "draftRevision"
       from lifecycle_process p join reference_value t on t.company_id = p.company_id and t.id = p.process_type_id
      where p.company_id = $1 order by p.code`,
    [grant.companyId],
  );
  return { items: rows.rows };
}

function checkTasks(tasks: readonly TemplateTaskInput[]): void {
  const codes = tasks.map((t) => t.code);
  if (new Set(codes).size !== codes.length) throw new HttpError(422, 'DUPLICATE_TASK_CODE', 'Each task code appears once');
  for (const [i, t] of tasks.entries()) {
    if (!Number.isInteger(t.dueOffsetDays)) throw new HttpError(422, 'INVALID_DUE_OFFSET', 'The due offset is a whole number of days', { task: i + 1 });
  }
}

async function insertTasks(tx: Queryable, grant: AccessGrant, revisionId: string, tasks: readonly TemplateTaskInput[]) {
  for (const [i, t] of tasks.entries()) {
    await validateOwner(tx, grant.companyId, t, i);
    await tx.query(
      `insert into lifecycle_process_task (company_id, revision_id, sequence, code, title, owner_kind, owner_role_code, owner_user_id, required, due_offset_days,
                                           evidence_required, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)`,
      [
        grant.companyId,
        revisionId,
        i + 1,
        t.code,
        t.title.trim(),
        t.ownerRoleCode !== undefined ? 'ROLE' : 'USER',
        t.ownerRoleCode ?? null,
        t.ownerUserId ?? null,
        t.required,
        t.dueOffsetDays,
        t.evidenceRequired,
        grant.userId,
      ],
    );
  }
}

export async function createTemplate(tx: Queryable, grant: AccessGrant, input: { code: string; name: string; processType: string; tasks?: TemplateTaskInput[] | undefined }) {
  const type = (
    await tx.query<{ id: string }>(`select id from reference_value_in_force where company_id = $1 and category = 'LIFECYCLE_PROCESS_TYPE' and code = $2`, [grant.companyId, input.processType])
  ).rows[0];
  if (!type) throw new HttpError(422, 'INVALID_REFERENCE', 'Unknown process type');
  const exists = await tx.query(`select 1 from lifecycle_process where company_id = $1 and code = $2`, [grant.companyId, input.code]);
  if ((exists.rowCount ?? 0) > 0) throw new HttpError(409, 'TEMPLATE_CODE_EXISTS', 'A process template with this code exists');
  const tasks = input.tasks ?? [];
  checkTasks(tasks);
  const id = (
    await tx.query<{ id: string }>(
      `insert into lifecycle_process (company_id, code, name, process_type_id, active, created_by, updated_by) values ($1, $2, $3, $4, true, $5, $5) returning id`,
      [grant.companyId, input.code, input.name.trim(), type.id, grant.userId],
    )
  ).rows[0]!.id;
  const revisionId = (
    await tx.query<{ id: string }>(
      `insert into lifecycle_process_revision (company_id, process_id, revision, state, created_by, updated_by) values ($1, $2, 1, 'DRAFT', $3, $3) returning id`,
      [grant.companyId, id, grant.userId],
    )
  ).rows[0]!.id;
  await insertTasks(tx, grant, revisionId, tasks);
  await audit(tx, actorOf(grant), 'lifecycle_process', id, 'CREATE', null, { operational: { code: input.code, processType: input.processType, revision: 1, taskCount: tasks.length } });
  return templateDetail(tx, grant, id);
}

export async function updateTemplate(tx: Queryable, grant: AccessGrant, id: string, input: { name?: string | undefined; active?: boolean | undefined; expectedVersion: number }) {
  const t = await loadTemplate(tx, grant.companyId, id, true);
  if (t.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The template changed; reload and retry');
  const name = input.name?.trim() ?? t.name;
  const active = input.active ?? t.active;
  await tx.query(`update lifecycle_process set name = $3, active = $4, updated_by = $5 where company_id = $1 and id = $2`, [grant.companyId, id, name, active, grant.userId]);
  await audit(tx, actorOf(grant), 'lifecycle_process', id, 'UPDATE', { operational: { name: t.name, active: t.active } }, { operational: { name, active } });
  return templateDetail(tx, grant, id);
}

/**
 * Replaces the tasks of the template's draft revision. Without a draft, a new one is opened (the next revision);
 * an existing draft is changed only against its current version.
 */
export async function saveDraft(tx: Queryable, grant: AccessGrant, id: string, input: { tasks: TemplateTaskInput[]; expectedVersion?: number | undefined }) {
  await loadTemplate(tx, grant.companyId, id, true);
  checkTasks(input.tasks);
  const draft = (
    await tx.query<{ id: string; revision: number; version: number }>(
      `select id, revision, version from lifecycle_process_revision where company_id = $1 and process_id = $2 and state = 'DRAFT' for update`,
      [grant.companyId, id],
    )
  ).rows[0];
  let revisionId: string;
  let revision: number;
  if (draft) {
    if (input.expectedVersion === undefined) throw new HttpError(409, 'STALE_VERSION', 'Give the draft version you are changing');
    if (draft.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The draft changed; reload and retry');
    await tx.query(`delete from lifecycle_process_task where company_id = $1 and revision_id = $2`, [grant.companyId, draft.id]);
    await tx.query(`update lifecycle_process_revision set updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, draft.id, grant.userId]);
    revisionId = draft.id;
    revision = draft.revision;
  } else {
    const next = (
      await tx.query<{ id: string; revision: number }>(
        `insert into lifecycle_process_revision (company_id, process_id, revision, state, created_by, updated_by)
         select $1, $2, coalesce(max(revision), 0) + 1, 'DRAFT', $3, $3 from lifecycle_process_revision where company_id = $1 and process_id = $2
         returning id, revision`,
        [grant.companyId, id, grant.userId],
      )
    ).rows[0]!;
    revisionId = next.id;
    revision = next.revision;
  }
  await insertTasks(tx, grant, revisionId, input.tasks);
  await audit(tx, actorOf(grant), 'lifecycle_process', id, 'SAVE_DRAFT', null, { operational: { revision, taskCount: input.tasks.length } });
  return templateDetail(tx, grant, id);
}

/** Publishes the draft: it becomes the revision new processes copy; the previously published one is retired. */
export async function publishTemplate(tx: Queryable, grant: AccessGrant, id: string, input: { revision: number; expectedVersion: number }) {
  await loadTemplate(tx, grant.companyId, id, true);
  const draft = (
    await tx.query<{ id: string; version: number; state: string; tasks: number }>(
      `select r.id, r.version, r.state, (select count(*)::int from lifecycle_process_task t where t.company_id = r.company_id and t.revision_id = r.id) as tasks
         from lifecycle_process_revision r where r.company_id = $1 and r.process_id = $2 and r.revision = $3 for update of r`,
      [grant.companyId, id, input.revision],
    )
  ).rows[0];
  if (!draft) throw notFound();
  if (draft.state !== 'DRAFT') throw new HttpError(409, 'INVALID_STATE', 'Only a draft revision can be published');
  if (draft.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The draft changed; reload and retry');
  if (draft.tasks === 0) throw new HttpError(422, 'NO_TASKS', 'A process template needs at least one task');
  const retired = (
    await tx.query<{ revision: number }>(
      `update lifecycle_process_revision set state = 'RETIRED', retired_at = now(), updated_by = $3 where company_id = $1 and process_id = $2 and state = 'PUBLISHED' returning revision`,
      [grant.companyId, id, grant.userId],
    )
  ).rows[0];
  await tx.query(`update lifecycle_process_revision set state = 'PUBLISHED', published_at = now(), published_by = $3, updated_by = $3 where company_id = $1 and id = $2`, [
    grant.companyId,
    draft.id,
    grant.userId,
  ]);
  await audit(tx, actorOf(grant), 'lifecycle_process', id, 'PUBLISH', { operational: { publishedRevision: retired?.revision ?? null } }, { operational: { publishedRevision: input.revision } });
  return templateDetail(tx, grant, id);
}
