// Expense claims and manual payment-outcome tracking (FR-070-FR-079; BR-017-BR-025; C5; DF03; DF06; DF07;
// CI03-CI06; ZT13-ZT15). All money arithmetic runs in PostgreSQL numeric.
import { createHash } from 'node:crypto';
import { enqueueEvent, writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import { type AccessGrant, canAccessEmployee, eligibleTasksOf, employeeScopePredicate, resolveAccess, SqlParams, taskDelegationLive } from '../access/authorize.js';
import { cancelActiveApproval, type Decision, decideTask, lockTransaction, scopeCovers, startApproval } from '../workflow/engine.js';
import { predecessorRequestSql, rejectedPredecessor } from '../workflow/predecessor.js';
import { expensePolicyLockKey } from './policies.js';

export interface LineInput {
  category: string;
  expenseDate: string;
  nights?: number | undefined;
  merchant: string;
  invoiceReference?: string | undefined;
  grossAmount: string;
  claimedAmount: string;
  description: string;
  exceptionReason?: string | undefined;
  /** A receipt uploaded first through POST /expense/receipts by the claimant. */
  receipt?: { receiptId: string } | undefined;
}

export interface DraftInput {
  purpose: string;
  currency: string;
  lines: LineInput[];
}

const OWNER_EDITABLE = ['DRAFT', 'RETURNED'];
/** FR-074, DF03 "Withdraw only before a final decision": every state from which a final approval has not committed. */
const WITHDRAWABLE = [...OWNER_EDITABLE, 'MANAGER_PENDING', 'FINANCE_PENDING', 'HIGH_VALUE_PENDING'];

async function insertLines(tx: Queryable, grant: AccessGrant, employeeId: string, revisionId: string, lines: LineInput[]) {
  let sequence = 0;
  for (const l of lines) {
    const category = (
      await tx.query<{ id: string }>(`select id from expense_category where company_id = $1 and code = $2 and active`, [grant.companyId, l.category])
    ).rows[0];
    if (!category) throw new HttpError(422, 'INVALID_REFERENCE', `Unknown expense category ${l.category}`);
    // Only the claimant's own uploaded receipt files can be attached; a client cannot name arbitrary files.
    const receipt = l.receipt
      ? (
          await tx.query<{ id: string; checksum: string; scan_state: string | null }>(
            `select a.id, a.checksum, a.scan_state from attachment a
              where a.company_id = $1 and a.id = $2 and a.owner_user_id = $3 and a.employee_id = $4 and a.classification = 'CONFIDENTIAL'
                and not exists (select 1 from employee_document d where d.company_id = a.company_id and d.attachment_id = a.id)`,
            [grant.companyId, l.receipt.receiptId, grant.userId, employeeId],
          )
        ).rows[0]
      : undefined;
    if (l.receipt && !receipt) throw new HttpError(422, 'INVALID_RECEIPT', 'The receipt was not uploaded by you');
    // FR-106: a receipt the scanner quarantined is not evidence (a pending scan may still be released).
    if (receipt?.scan_state === 'QUARANTINED') throw new HttpError(422, 'RECEIPT_QUARANTINED', 'The receipt failed the malware scan; upload another file');
    const fingerprint = createHash('sha256')
      .update([employeeId, l.expenseDate, l.category, Number(l.claimedAmount).toFixed(2), receipt?.checksum ?? ''].join('|'))
      .digest('hex');
    const lineId = (
      await tx.query<{ id: string }>(
        `insert into expense_line (company_id, revision_id, sequence, category_id, expense_date, nights, merchant, invoice_reference, gross_amount,
                                   claimed_amount, description, exception_reason, fingerprint, created_by, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::numeric, $10::numeric, $11, $12, $13, $14, $14) returning id`,
        [grant.companyId, revisionId, ++sequence, category.id, l.expenseDate, l.nights ?? null, l.merchant.trim(), l.invoiceReference?.trim() || null, l.grossAmount, l.claimedAmount, l.description.trim(), l.exceptionReason?.trim() || null, fingerprint, grant.userId],
      )
    ).rows[0]!.id;
    if (receipt) {
      // Receipts are confidential attachments of the claimant (DF06); the claimant sees presence only.
      await tx.query(`insert into expense_receipt (company_id, line_id, attachment_id, created_by, updated_by) values ($1, $2, $3, $4, $4)`, [
        grant.companyId,
        lineId,
        receipt.id,
        grant.userId,
      ]);
    }
  }
}

export async function createDraft(tx: Queryable, grant: AccessGrant, input: DraftInput & { predecessorRequestId?: string | undefined }) {
  const employeeId = grant.linkedEmployeeId;
  if (!employeeId) throw new HttpError(403, 'FORBIDDEN', 'Not permitted');
  await reassertAccess(tx, grant, 'expense', 'draft', ['operational']);
  const predecessor = await rejectedPredecessor(tx, grant.companyId, 'expense_claim', employeeId, input.predecessorRequestId);
  const transactionId = (
    await tx.query<{ id: string }>(
      `insert into business_transaction (company_id, kind, owner_employee_id, state, predecessor_transaction_id, created_by, updated_by)
       values ($1, 'expense_claim', $2, 'DRAFT', $4, $3, $3) returning id`,
      [grant.companyId, employeeId, grant.userId, predecessor],
    )
  ).rows[0]!.id;
  const claimId = (
    await tx.query<{ id: string }>(
      `insert into expense_claim (company_id, employee_id, transaction_id, purpose, currency_code, current_revision, state, payment_state, created_by, updated_by)
       values ($1, $2, $3, $4, $5, 1, 'DRAFT', 'NOT_APPLICABLE', $6, $6) returning id`,
      [grant.companyId, employeeId, transactionId, input.purpose.trim(), input.currency, grant.userId],
    )
  ).rows[0]!.id;
  const revisionId = (
    await tx.query<{ id: string }>(
      `insert into expense_revision (company_id, claim_id, revision, currency_code, purpose, created_by, updated_by) values ($1, $2, 1, $3, $4, $5, $5) returning id`,
      [grant.companyId, claimId, input.currency, input.purpose.trim(), grant.userId],
    )
  ).rows[0]!.id;
  await insertLines(tx, grant, employeeId, revisionId, input.lines);
  return { claimId, revision: 1, state: 'DRAFT' };
}

interface ClaimRow {
  id: string;
  employee_id: string;
  transaction_id: string;
  current_revision: number;
  state: string;
  currency_code: string;
  version: number;
}

async function lockClaim(tx: Queryable, companyId: string, column: 'id' | 'transaction_id', value: string): Promise<ClaimRow> {
  const row = (
    await tx.query<ClaimRow>(
      `select id, employee_id, transaction_id, current_revision, state, currency_code, version from expense_claim where company_id = $1 and ${column} = $2 for update`,
      [companyId, value],
    )
  ).rows[0];
  if (!row) throw notFound();
  return row;
}

/**
 * The claim for a state change by its claimant. Revising, submitting, withdrawing and every decision on one claim run one
 * after another under the engine's key (lockTransaction), taken before any row lock as decideTask takes it, so a
 * withdrawal and a final approval at the same moment give one result and the later one finds the earlier one's state.
 */
async function lockClaimForChange(tx: Queryable, companyId: string, claimId: string): Promise<ClaimRow> {
  const located = (await tx.query<{ transaction_id: string }>(`select transaction_id from expense_claim where company_id = $1 and id = $2`, [companyId, claimId])).rows[0];
  if (!located) throw notFound();
  await lockTransaction(tx, located.transaction_id);
  return lockClaim(tx, companyId, 'id', claimId);
}

async function currentRevision(tx: Queryable, companyId: string, claim: ClaimRow) {
  return (
    await tx.query<{ id: string; submitted_at: string | null }>(`select id, submitted_at from expense_revision where company_id = $1 and claim_id = $2 and revision = $3`, [
      companyId,
      claim.id,
      claim.current_revision,
    ])
  ).rows[0]!;
}

/** Edits the owner's draft; a returned claim gets a new revision (earlier submitted facts stay untouched, FR-074). */
export async function reviseDraft(tx: Queryable, grant: AccessGrant, claimId: string, input: DraftInput & { expectedVersion: number }) {
  const claim = await lockClaimForChange(tx, grant.companyId, claimId);
  if (claim.employee_id !== grant.linkedEmployeeId) throw notFound();
  await reassertAccess(tx, grant, 'expense', 'draft', ['operational']);
  if (claim.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');
  if (!OWNER_EDITABLE.includes(claim.state)) throw new HttpError(409, 'INVALID_STATE', 'Only drafts and returned claims can be edited');
  if (input.currency !== claim.currency_code) throw new HttpError(422, 'RULE_VIOLATION', 'A claim keeps one currency');
  const purpose = input.purpose.trim();

  let revisionId: string;
  let revision = claim.current_revision;
  const current = await currentRevision(tx, grant.companyId, claim);
  if (current.submitted_at) {
    revision += 1;
    revisionId = (
      await tx.query<{ id: string }>(
        `insert into expense_revision (company_id, claim_id, revision, currency_code, purpose, created_by, updated_by) values ($1, $2, $3, $4, $5, $6, $6) returning id`,
        [grant.companyId, claim.id, revision, claim.currency_code, purpose, grant.userId],
      )
    ).rows[0]!.id;
    await writeAudit(tx, {
      companyId: grant.companyId,
      resource: 'expense_claim',
      recordKey: claim.id,
      actorUserId: grant.userId,
      actingAssignmentId: grant.assignmentId,
      action: 'REVISE',
      priorVersion: claim.version,
      before: { operational: { revision: claim.current_revision } },
      after: { operational: { revision } },
    });
  } else {
    revisionId = current.id;
    await tx.query(`delete from expense_receipt where company_id = $1 and line_id in (select id from expense_line where revision_id = $2)`, [grant.companyId, revisionId]);
    await tx.query(`delete from expense_line where company_id = $1 and revision_id = $2`, [grant.companyId, revisionId]);
    await tx.query(`update expense_revision set purpose = $3, updated_by = $4 where company_id = $1 and id = $2`, [grant.companyId, revisionId, purpose, grant.userId]);
  }
  await insertLines(tx, grant, claim.employee_id, revisionId, input.lines);
  // The claim keeps a copy of its current revision's purpose; the revision's own, frozen at submission, is the record (line 103).
  await tx.query(`update expense_claim set purpose = $3, current_revision = $4, updated_by = $5 where company_id = $1 and id = $2`, [grant.companyId, claim.id, purpose, revision, grant.userId]);
  return { claimId: claim.id, revision, state: claim.state };
}

interface LineCheck {
  id: string;
  sequence: number;
  category: string;
  expense_date: string;
  claimed: string;
  exception_reason: string | null;
  future: boolean;
  late: boolean;
  rule_id: string | null;
  rule_tied: boolean;
  over_limit: boolean;
  nights_missing: boolean;
  receipt_missing: boolean;
  duplicate: boolean;
}

/** FR-071 / DF06 submission validation; flags need a claimant reason; hard errors block. */
export async function submitClaim(tx: Queryable, grant: AccessGrant, claimId: string, expectedVersion: number) {
  const claim = await lockClaimForChange(tx, grant.companyId, claimId);
  if (claim.employee_id !== grant.linkedEmployeeId) throw notFound();
  if (claim.version !== expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');
  if (!OWNER_EDITABLE.includes(claim.state)) throw new HttpError(409, 'INVALID_STATE', 'This claim is not open for submission');
  await reassertAccess(tx, grant, 'expense', 'submit', ['operational']);
  const revision = await currentRevision(tx, grant.companyId, claim);
  if (revision.submitted_at) throw new HttpError(409, 'INVALID_STATE', 'Edit the returned claim before resubmitting');

  // FR-078, BR-019, DF06: each line falls under the one revision in force on its expense date; none, or more than one, blocks
  // the submission. A retired revision stays in force until its end (0116). Held shared, so a revision cannot be end-dated
  // past this submission while it is in flight, and a submission cannot pin a revision being closed.
  await tx.query(`select pg_advisory_xact_lock_shared(hashtextextended($1, 0))`, [expensePolicyLockKey(grant.companyId)]);
  const coverage = (
    await tx.query<{ sequence: number; policies: string[] }>(
      `select l.sequence, array(select p.id::text from expense_policy p
                                 where p.company_id = l.company_id and (p.state = 'ACTIVE' or (p.state = 'RETIRED' and p.effective_to is not null))
                                   and p.effective_from <= l.expense_date and (p.effective_to is null or p.effective_to > l.expense_date)) as policies
         from expense_line l where l.company_id = $1 and l.revision_id = $2 order by l.sequence`,
      [grant.companyId, revision.id],
    )
  ).rows;
  if (coverage.length === 0) throw new HttpError(422, 'RULE_VIOLATION', 'A claim needs at least one line');
  const uncovered = coverage.filter((c) => c.policies.length === 0).map((c) => c.sequence);
  if (uncovered.length > 0) throw new HttpError(422, 'POLICY_NOT_FOUND', 'No active expense policy covers these expense dates', { lines: uncovered });
  const policyIds = [...new Set(coverage.flatMap((c) => c.policies))];
  if (policyIds.length > 1) throw new HttpError(422, 'POLICY_AMBIGUOUS', 'Lines fall under different policy revisions; split the claim');
  const policy = (
    await tx.query<{ id: string; currency_code: string; submission_window_days: number }>(`select id, currency_code, submission_window_days from expense_policy where company_id = $1 and id = $2`, [grant.companyId, policyIds[0]])
  ).rows[0]!;
  if (policy.currency_code !== claim.currency_code) throw new HttpError(422, 'UNSUPPORTED_CURRENCY', `Claims must be in ${policy.currency_code}`);

  // Duplicate checks compare only submitted revisions, so concurrent submissions that could match each other are
  // serialised: the later one's comparison (a new READ COMMITTED snapshot) then sees the earlier one's submission. A
  // fingerprint only ever matches the same employee's lines; a receipt file (by checksum) and a merchant's invoice reference
  // are matched company-wide. Keys are taken in one fixed (sorted) order, so two submissions cannot deadlock on them.
  const lockKeys = (
    await tx.query<{ lock_key: string }>(
      `select distinct hashtextextended(k, 0) as lock_key from (
         select 'expense_duplicate:employee:' || $2::text as k
         union all
         select 'expense_duplicate:receipt:' || a.company_id::text || ':' || a.checksum
           from expense_line l
           join expense_receipt er on er.company_id = l.company_id and er.line_id = l.id
           join attachment a on a.company_id = er.company_id and a.id = er.attachment_id
          where l.company_id = $1 and l.revision_id = $3
         union all
         select 'expense_duplicate:invoice:' || l.company_id::text || ':' || hrms_expense_invoice_key(l.merchant, l.invoice_reference)
           from expense_line l
          where l.company_id = $1 and l.revision_id = $3 and hrms_expense_invoice_key(l.merchant, l.invoice_reference) is not null) keys
        order by lock_key`,
      [grant.companyId, claim.employee_id, revision.id],
    )
  ).rows;
  for (const { lock_key } of lockKeys) await tx.query(`select pg_advisory_xact_lock($1::bigint)`, [lock_key]);

  const checks = (
    await tx.query<LineCheck>(
      `with today as (select hrms_business_date($1, now()) as d),
            -- Suspected-duplicate comparison set (FR-075, BR-023, DF06): the lines of this revision, and the lines of the
            -- submitted current revision of every other live claim in the company. Never-submitted drafts, superseded
            -- revisions and this claim's other revisions are not compared. Not materialized, so each probe stays indexed.
            peer as not materialized (
              select o.id, o.fingerprint, hrms_expense_invoice_key(o.merchant, o.invoice_reference) as invoice_key from expense_line o where o.company_id = $1 and o.revision_id = $6
              union all
              select o.id, o.fingerprint, hrms_expense_invoice_key(o.merchant, o.invoice_reference) as invoice_key from expense_line o
                join expense_revision orv on orv.company_id = o.company_id and orv.id = o.revision_id and orv.submitted_at is not null
                join expense_claim oc on oc.company_id = orv.company_id and oc.id = orv.claim_id and oc.current_revision = orv.revision
               where o.company_id = $1 and oc.id <> $3 and oc.state not in ('REJECTED', 'WITHDRAWN')),
            -- DF06 "Per-day/night grouping uses actual expense service date and declared nights": the nights each stay of this
            -- employee covers, in this revision and in their other live submitted claims (the employee lock above orders those).
            stay as materialized (
              select n.id, n.category_id, n.claimed_amount, n.expense_date as first_night, n.expense_date + n.nights - 1 as last_night
                from expense_line n where n.company_id = $1 and n.revision_id = $6 and n.nights is not null
              union all
              select n.id, n.category_id, n.claimed_amount, n.expense_date, n.expense_date + n.nights - 1
                from expense_line n
                join expense_revision nr on nr.company_id = n.company_id and nr.id = n.revision_id and nr.submitted_at is not null
                join expense_claim nc on nc.company_id = nr.company_id and nc.id = nr.claim_id and nc.current_revision = nr.revision
               where nc.company_id = $1 and nc.employee_id = $4 and nc.id <> $3 and nc.state not in ('REJECTED', 'WITHDRAWN') and n.nights is not null)
       select l.id, l.sequence, c.code as category, to_char(l.expense_date, 'YYYY-MM-DD') as expense_date, l.claimed_amount::text as claimed,
              l.exception_reason,
              l.expense_date > t.d as future,
              (t.d - l.expense_date) > $5 as late,
              r.id as rule_id,
              coalesce(r.equals, 0) > 1 as rule_tied,
              case c.limit_basis
                when 'PER_LINE'  then l.claimed_amount > r.limit_amount
                -- The limit is per night and a line states only a total, so nothing says which night of a stay cost what.
                -- Over the limit means no spreading could fit: over some run of nights, from the first night of a stay sharing
                -- a night with this line to the last night of one, the stays wholly inside it claim more than limit x nights.
                -- With no other stay that is this line's own amount against limit x its nights.
                when 'PER_NIGHT' then l.nights is not null and exists (
                  select 1 from stay a, stay b
                   where a.category_id = l.category_id and b.category_id = l.category_id
                     and a.first_night <= l.expense_date and a.last_night >= l.expense_date
                     and b.last_night >= l.expense_date + l.nights - 1 and b.first_night <= l.expense_date + l.nights - 1
                     and (select sum(x.claimed_amount) from stay x
                           where x.category_id = l.category_id and x.first_night >= a.first_night and x.last_night <= b.last_night)
                         > r.limit_amount * (b.last_night - a.first_night + 1))
                when 'PER_DAY'   then (select sum(x.claimed_amount) from expense_line x
                                         where x.company_id = l.company_id and x.revision_id = l.revision_id
                                           and x.category_id = l.category_id and x.expense_date = l.expense_date)
                                      + coalesce((select sum(y.claimed_amount) from expense_line y
                                                    join expense_revision yr on yr.company_id = y.company_id and yr.id = y.revision_id and yr.submitted_at is not null
                                                    join expense_claim yc on yc.company_id = yr.company_id and yc.id = yr.claim_id and yc.current_revision = yr.revision
                                                   where yc.company_id = l.company_id and yc.employee_id = $4 and yc.id <> $3
                                                     and yc.state not in ('REJECTED', 'WITHDRAWN')
                                                     and y.category_id = l.category_id and y.expense_date = l.expense_date), 0) > r.limit_amount
              end as over_limit,
              c.limit_basis = 'PER_NIGHT' and l.nights is null as nights_missing,
              -- FR-106: a receipt quarantined since the draft was saved is no receipt (one still being scanned may yet be
              -- released; the financial decision checks again).
              coalesce(r.receipt_required, true) and not exists (select 1 from expense_receipt er join attachment a on a.company_id = er.company_id and a.id = er.attachment_id
                                                                  where er.company_id = l.company_id and er.line_id = l.id and a.scan_state is distinct from 'QUARANTINED') as receipt_missing,
              -- Another line (never the line itself) with the same fingerprint, the same merchant and invoice reference, or a
              -- receipt file of the same checksum.
              exists (select 1 from peer p where p.id <> l.id and p.fingerprint = l.fingerprint)
              or exists (select 1 from peer p where p.id <> l.id and p.invoice_key = hrms_expense_invoice_key(l.merchant, l.invoice_reference))
              or exists (select 1 from expense_receipt mine
                           join attachment ma on ma.company_id = mine.company_id and ma.id = mine.attachment_id
                           join attachment oa on oa.company_id = ma.company_id and oa.checksum = ma.checksum
                           join expense_receipt other on other.company_id = oa.company_id and other.attachment_id = oa.id
                           join peer p on p.id = other.line_id and p.id <> l.id
                          where mine.company_id = l.company_id and mine.line_id = l.id) as duplicate
         from today t, expense_line l
         join expense_category c on c.company_id = l.company_id and c.id = l.category_id
         -- BR-019, DF06: the employee's classification on the expense date, as the policy that applies is the one of that date.
         left join lateral (
           select ea.grade_id, ea.location_id from employment_assignment ea
            where ea.company_id = l.company_id and ea.employee_id = $4
              and ea.effective_from <= l.expense_date and (ea.effective_to is null or ea.effective_to > l.expense_date)) ea on true
         -- The rule naming most of grade and location wins; two equally specific ones are never picked between (FR-078).
         left join lateral (
           select pr.id, pr.limit_amount, pr.receipt_required, count(*) over (partition by num_nonnulls(pr.grade_id, pr.location_id)) as equals
             from expense_policy_rule pr
            where pr.company_id = l.company_id and pr.policy_id = $2 and pr.category_id = l.category_id
              and (pr.grade_id is null or pr.grade_id = ea.grade_id)
              and (pr.location_id is null or pr.location_id = ea.location_id)
            order by num_nonnulls(pr.grade_id, pr.location_id) desc limit 1) r on true
        where l.company_id = $1 and l.revision_id = $6
        order by l.sequence`,
      [grant.companyId, policy.id, claim.id, claim.employee_id, policy.submission_window_days, revision.id],
    )
  ).rows;

  const tied = checks.filter((c) => c.rule_tied).map((c) => c.sequence);
  if (tied.length) throw new HttpError(422, 'POLICY_AMBIGUOUS', 'Two equally specific policy rules apply to these lines; HR needs to resolve them', { lines: tied });
  const errors: { line: number; code: string }[] = [];
  for (const c of checks) {
    if (c.future) errors.push({ line: c.sequence, code: 'FUTURE_EXPENSE_DATE' });
    if (!c.rule_id) errors.push({ line: c.sequence, code: 'CATEGORY_NOT_ELIGIBLE' });
    if (c.nights_missing) errors.push({ line: c.sequence, code: 'NIGHTS_REQUIRED' });
  }
  if (errors.length) throw new HttpError(422, 'CLAIM_INVALID', 'The claim cannot be submitted', { errors });

  const flagged = checks.map((c) => ({
    check: c,
    flags: [c.late && 'LATE_SUBMISSION', c.over_limit && 'OVER_LIMIT', c.receipt_missing && 'RECEIPT_MISSING', c.duplicate && 'DUPLICATE_SUSPECTED'].filter(Boolean) as string[],
  }));
  // Validate everything first, then record the flags (flags without a reason are rejected by the schema too).
  const needReason = flagged.filter((f) => f.flags.length && !f.check.exception_reason).map((f) => ({ line: f.check.sequence, flags: f.flags }));
  if (needReason.length) throw new HttpError(422, 'EXCEPTION_REASON_REQUIRED', 'Flagged lines need an exception reason', { lines: needReason });
  // FR-078 "retain the rules used": the rule each line was judged under, frozen with the line and by activation (0116).
  for (const f of flagged) {
    await tx.query(`update expense_line set exception_flags = $3, applied_rule_id = $4 where company_id = $1 and id = $2`, [grant.companyId, f.check.id, f.flags, f.check.rule_id]);
  }

  await tx.query(`update expense_revision set policy_id = $3, submitted_at = now(), submitted_by = $4, updated_by = $4 where company_id = $1 and id = $2`, [
    grant.companyId,
    revision.id,
    policy.id,
    grant.userId,
  ]);
  await tx.query(`update business_transaction set revision = $3, state = 'MANAGER_PENDING', updated_by = $4 where company_id = $1 and id = $2`, [
    grant.companyId,
    claim.transaction_id,
    claim.current_revision,
    grant.userId,
  ]);
  await tx.query(`update expense_claim set state = 'MANAGER_PENDING', updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, claim.id, grant.userId]);
  const { taskId } = await startApproval(tx, { companyId: grant.companyId, kind: 'expense_claim', transactionId: claim.transaction_id, ownerEmployeeId: claim.employee_id, actorUserId: grant.userId });

  const total = (await tx.query<{ t: string }>(`select sum(claimed_amount)::text as t from expense_line where company_id = $1 and revision_id = $2`, [grant.companyId, revision.id])).rows[0]!.t;
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'expense_claim',
    recordKey: claim.id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'SUBMIT',
    priorVersion: claim.version,
    after: { operational: { revision: claim.current_revision, total, lines: checks.length } },
  });
  await enqueueEvent(tx, {
    companyId: grant.companyId,
    topic: 'expense.submitted',
    aggregateId: claim.id,
    dedupeKey: `expense.submitted:${claim.id}:${claim.current_revision}`,
    payload: { claimId: claim.id, taskId, revision: claim.current_revision },
  });
  return { claimId: claim.id, revision: claim.current_revision, state: 'MANAGER_PENDING', total };
}

/** The decision action required by the caller's open task on an expense claim (route uses it to authorise). */
export async function taskAction(db: Queryable, companyId: string, userId: string, taskId: string): Promise<string | null> {
  const row = (
    await db.query<{ action: string }>(
      `select p.action from approval_task t join workflow_step s on s.company_id = t.company_id and s.id = t.step_id join permission p on p.id = s.permission_id
        where t.company_id = $1 and t.id = $2 and t.assignee_user_id = $3 and p.resource = 'expense'`,
      [companyId, taskId, userId],
    )
  ).rows[0];
  return row?.action ?? null;
}

export interface ExpenseDecisionInput {
  decision: Decision;
  reason?: string | undefined;
  idempotencyKey: string;
  /** Required with APPROVE on the financial step: every line of the revision (FR-073). */
  lines?: { lineId: string; allowedAmount: string; reason?: string | undefined }[] | undefined;
}

export async function decideExpense(tx: Queryable, grant: AccessGrant, taskId: string, action: string, input: ExpenseDecisionInput) {
  const claimForTask = (
    await tx.query<{ id: string; high_value: boolean; revision_id: string }>(
      `select c.id, r.id as revision_id,
              (select sum(claimed_amount) from expense_line where company_id = r.company_id and revision_id = r.id) > p.high_value_threshold as high_value
         from approval_task t join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id
         join expense_claim c on c.company_id = i.company_id and c.transaction_id = i.transaction_id
         join expense_revision r on r.company_id = c.company_id and r.claim_id = c.id and r.revision = i.transaction_revision
         join expense_policy p on p.company_id = r.company_id and p.id = r.policy_id
        where t.company_id = $1 and t.id = $2`,
      [grant.companyId, taskId],
    )
  ).rows[0];
  if (!claimForTask) throw notFound();
  const highValue = claimForTask.high_value; // routing on the immutable submitted total, compared in numeric (F6)

  const result = await decideTask(tx, {
    grant,
    taskId,
    decision: input.decision,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
    permission: { resource: 'expense', action },
    stepApplies: (code) => code === 'EXPENSE_HIGH_VALUE' && highValue,
    onDecided: async (decisionId) => {
      if (action !== 'finance_decide' || input.decision !== 'APPROVE') return;
      const revisionLines = (
        await tx.query<{ id: string; sequence: number; exception_flags: string[]; receipt_unreleased: boolean }>(
          `select l.id, l.sequence, l.exception_flags,
                  exists (select 1 from expense_receipt er join attachment a on a.company_id = er.company_id and a.id = er.attachment_id
                           where er.company_id = l.company_id and er.line_id = l.id and a.scan_state is distinct from 'CLEAN') as receipt_unreleased
             from expense_line l where l.company_id = $1 and l.revision_id = $2 order by l.sequence`,
          [grant.companyId, claimForTask.revision_id],
        )
      ).rows;
      const decisions = new Map((input.lines ?? []).map((l) => [l.lineId, l]));
      if (revisionLines.length !== decisions.size || revisionLines.some((l) => !decisions.has(l.id))) {
        throw new HttpError(422, 'ALL_LINES_REQUIRED', 'Financial approval must decide every line of the claim');
      }
      // FR-075, BR-023, DF06: accepting a flagged line is a documented clearance, whatever amount is allowed; the
      // claimant's own reason does not stand in for the reviewer's (the database refuses it too, 0096). FR-106: so is a line
      // whose receipt the scanner has not released, as it may have been quarantined after the frozen flags were set (0117).
      const uncleared = revisionLines.filter((l) => (l.exception_flags.length > 0 || l.receipt_unreleased) && !decisions.get(l.id)!.reason?.trim());
      if (uncleared.length > 0) {
        throw new HttpError(422, 'CLEARANCE_REASON_REQUIRED', 'A flagged line needs a recorded clearance reason', {
          lines: uncleared.map((l) => ({ line: l.sequence, flags: [...l.exception_flags, ...(l.receipt_unreleased ? ['RECEIPT_NOT_RELEASED'] : [])] })),
        });
      }
      for (const l of input.lines!) {
        await tx.query(
          `insert into expense_line_decision (company_id, line_id, approval_decision_id, allowed_amount, exception_reason, created_by, updated_by)
           values ($1, $2, $3, $4::numeric, $5, $6, $6)`,
          [grant.companyId, l.lineId, decisionId, l.allowedAmount, l.reason?.trim() || null, grant.userId],
        );
      }
    },
  });
  const claim = await lockClaim(tx, grant.companyId, 'transaction_id', result.transactionId);
  if (result.replayed) return { claimId: claim.id, state: claim.state, replayed: true };
  // decideTask has checked the decider's row scope; an ASSIGNED decider's task is no longer pending here.
  if (!result.ownerEmployeeId) throw notFound();

  let state: string;
  if (result.outcome === 'NEXT_STEP') state = action === 'manager_decide' ? 'FINANCE_PENDING' : 'HIGH_VALUE_PENDING';
  else state = result.outcome;
  let paymentState = 'NOT_APPLICABLE';
  let approvedAmount: string | null = null;
  if (state === 'APPROVED') {
    approvedAmount = (
      await tx.query<{ total: string }>(
        `select coalesce(sum(x.allowed_amount), 0)::numeric(19,4)::text as total from (
           select distinct on (d.line_id) d.allowed_amount from expense_line_decision d join expense_line l on l.company_id = d.company_id and l.id = d.line_id
            where l.company_id = $1 and l.revision_id = $2 order by d.line_id, d.created_at desc) x`,
        [grant.companyId, claimForTask.revision_id],
      )
    ).rows[0]!.total;
    if (Number(approvedAmount) > 0) {
      // One obligation per approved claim, equal to the final line decisions (CI03, BR-024).
      await tx.query(
        `insert into expense_obligation (company_id, claim_id, revision_id, employee_id, approved_amount, currency_code, approved_by, created_by, updated_by)
         values ($1, $2, $3, $4, $5::numeric, $6, $7, $7, $7)`,
        [grant.companyId, claim.id, claimForTask.revision_id, claim.employee_id, approvedAmount, claim.currency_code, grant.userId],
      );
      paymentState = 'UNPAID';
    } else {
      paymentState = 'NO_PAYABLE_AMOUNT';
    }
  }
  await tx.query(`update business_transaction set state = $3, updated_by = $4 where company_id = $1 and id = $2`, [grant.companyId, claim.transaction_id, state, grant.userId]);
  await tx.query(`update expense_claim set state = $3, payment_state = $4, updated_by = $5 where company_id = $1 and id = $2`, [grant.companyId, claim.id, state, paymentState, grant.userId]);
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'expense_claim',
    recordKey: claim.id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: `${action.toUpperCase()}_${input.decision}`,
    priorVersion: claim.version,
    before: { operational: { state: claim.state } },
    after: { operational: { state, approvedAmount } },
    reason: input.reason ?? null,
  });
  if (state === 'FINANCE_PENDING' || state === 'HIGH_VALUE_PENDING') {
    // DF12 "assigned": the reviewer of the step this decision opened.
    const next = (await tx.query<{ id: string }>(`select id from approval_task where company_id = $1 and instance_id = $2 and state = 'PENDING' order by created_at desc limit 1`, [grant.companyId, result.instanceId])).rows[0];
    if (next) {
      await enqueueEvent(tx, {
        companyId: grant.companyId,
        topic: 'expense.assigned',
        aggregateId: claim.id,
        dedupeKey: `expense.assigned:${next.id}`,
        payload: { claimId: claim.id, taskId: next.id, revision: claim.current_revision },
      });
    }
  } else {
    await enqueueEvent(tx, {
      companyId: grant.companyId,
      topic: 'expense.decided',
      aggregateId: claim.id,
      dedupeKey: `expense.decided:${claim.id}:${input.idempotencyKey}`,
      payload: { claimId: claim.id, outcome: state, revision: claim.current_revision, paymentState },
    });
  }
  return { claimId: claim.id, state, approvedAmount, paymentState, replayed: false };
}

/**
 * FR-074, DF03, C5: the claimant withdraws at any step before the final approval commits. Serialised with every decision
 * (lockClaimForChange), so with a final approval at the same moment one wins and the other is refused: a withdrawn claim
 * has no open task (409 TASK_CLOSED), and an approved claim is no longer withdrawable (409 INVALID_STATE, no second result).
 */
export async function withdrawClaim(tx: Queryable, grant: AccessGrant, claimId: string) {
  const claim = await lockClaimForChange(tx, grant.companyId, claimId);
  if (claim.employee_id !== grant.linkedEmployeeId) throw notFound();
  await reassertAccess(tx, grant, 'expense', 'withdraw', ['operational']);
  if (!WITHDRAWABLE.includes(claim.state)) throw new HttpError(409, 'INVALID_STATE', 'A decided claim can no longer be withdrawn');
  await cancelActiveApproval(tx, grant.companyId, claim.transaction_id, grant.userId);
  await tx.query(`update business_transaction set state = 'WITHDRAWN', updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, claim.transaction_id, grant.userId]);
  await tx.query(`update expense_claim set state = 'WITHDRAWN', updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, claim.id, grant.userId]);
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'expense_claim',
    recordKey: claim.id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'WITHDRAW',
    priorVersion: claim.version,
    before: { operational: { state: claim.state } },
    after: { operational: { state: 'WITHDRAWN' } },
  });
  // DF12 "withdrawn/cancelled": the reviewer of the latest task is told. A draft that was never submitted had no reviewer.
  const lastTask = (
    await tx.query<{ id: string }>(
      `select t.id from approval_task t join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id
        where i.company_id = $1 and i.transaction_id = $2 order by t.created_at desc limit 1`,
      [grant.companyId, claim.transaction_id],
    )
  ).rows[0];
  if (lastTask) {
    await enqueueEvent(tx, {
      companyId: grant.companyId,
      topic: 'expense.withdrawn',
      aggregateId: claim.id,
      dedupeKey: `expense.withdrawn:${claim.id}`,
      payload: { claimId: claim.id, taskId: lastTask.id },
    });
  }
  return { claimId: claim.id, state: 'WITHDRAWN' };
}

/**
 * DF12 "payment operational status" for the claimant: what was recorded and the status it leaves, read after the ledger
 * moved. The key is the payment event, never its evidence key, which is a restricted outcome reference (DF07).
 */
async function paymentStatusEvent(tx: Queryable, companyId: string, claimId: string, paymentEventId: string, paymentEvent: 'CONFIRMED' | 'FAILED' | 'REVERSED') {
  const paymentState = (await tx.query<{ payment_state: string }>(`select payment_state from expense_claim where company_id = $1 and id = $2`, [companyId, claimId])).rows[0]!.payment_state;
  await enqueueEvent(tx, {
    companyId,
    topic: 'expense.payment_status',
    aggregateId: claimId,
    dedupeKey: `expense.payment_status:${paymentEventId}:${claimId}`,
    payload: { claimId, paymentEvent, paymentState },
  });
}

/** Approved claims with an outstanding entitlement, in the payment operator's scope (DF07). */
export async function listPayables(db: Queryable, grant: AccessGrant) {
  const params = new SqlParams();
  const scope = employeeScopePredicate(grant, { company: 'c.company_id', employee: 'c.employee_id' }, params);
  const rows = await db.query(
    `select c.id as "claimId", e.employee_code as "employeeCode", e.display_name as "employeeName", ar.purpose, c.payment_state as "paymentState",
            l.approved_amount::numeric(19,2)::text as "approvedAmount", l.net_paid::numeric(19,2)::text as "netPaid",
            l.pending::numeric(19,2)::text as pending, (l.approved_amount - l.net_paid - l.pending)::numeric(19,2)::text as allocatable,
            l.currency_code as currency, o.approved_by as "entitlementApprovedBy"
       from expense_claim c
       join employee e on e.company_id = c.company_id and e.id = c.employee_id
       join expense_obligation_ledger l on l.company_id = c.company_id and l.claim_id = c.id
       join expense_obligation o on o.company_id = c.company_id and o.id = l.obligation_id
       join expense_revision ar on ar.company_id = o.company_id and ar.id = o.revision_id
      where ${scope} and c.state = 'APPROVED' and c.payment_state <> 'PAID'
      order by e.employee_code, c.created_at`,
    params.values,
  );
  return { items: rows.rows };
}

export async function listInstructions(db: Queryable, grant: AccessGrant, claimId: string) {
  const owner = (await db.query<{ employee_id: string }>(`select employee_id from expense_claim where company_id = $1 and id = $2`, [grant.companyId, claimId])).rows[0];
  if (!owner || !(await canAccessEmployee(db, grant, owner.employee_id))) throw notFound();
  // The claim's share of each payment: its allocation and the reversals charged to it (an instruction may pay several
  // claims of one employee, CI05), so the list reconciles with the claim's ledger.
  const rows = await db.query(
    `select i.id, a.amount::numeric(19,2)::text as amount, i.currency_code as currency, i.state, i.payment_date as "paymentDate",
            b.state as "batchState", b.prepared_by as "preparedBy", i.released_by as "releasedBy", i.retry_of_id as "retryOfInstructionId",
            i.outcome_actor_id as "outcomeActorUserId", oa.account_key as "outcomeActorAccountKey", coalesce(i.outcome_actor_id = $3, false) as "outcomeAssignedToMe",
            coalesce((select sum(e.amount) from payment_event e where e.company_id = a.company_id and e.allocation_id = a.id and e.event_kind = 'REVERSED'), 0)::numeric(19,2)::text as reversed
       from payment_allocation a
       join payment_instruction i on i.company_id = a.company_id and i.id = a.instruction_id
       join payment_batch b on b.company_id = i.company_id and b.id = i.batch_id
       join expense_obligation o on o.company_id = a.company_id and o.id = a.obligation_id
       left join user_account oa on oa.id = i.outcome_actor_id
      where a.company_id = $1 and o.claim_id = $2 order by i.created_at`,
    [grant.companyId, claimId, grant.userId],
  );
  return { items: rows.rows };
}

/**
 * DF02 "Expense operational amounts are visible only to claimant and assigned expense reviewers/payment operators", on top
 * of row scope, with "data requests, attachments, exports": the SQL condition (claim alias c) under which this assignment
 * reads a claim. The claimant reads their own; a holder of the payment read duty every claim that was submitted; anyone
 * else only a claim whose approval route gave them a task, open or decided, so not a draft, a claim from before they became
 * the manager or one routed to a fallback reviewer. The task must be one this assignment's role and DB109 entry can decide,
 * so a task routed through another assignment of the same user lends it nothing (I-52), and a delegated task counts only
 * while its delegation is live (I-57).
 */
export async function claimReadCondition(db: Queryable, grant: AccessGrant, params: SqlParams): Promise<string> {
  const own = grant.linkedEmployeeId ? `c.employee_id = ${params.add(grant.linkedEmployeeId)}::uuid` : 'false';
  const operator = await resolveAccess(db, { userId: grant.userId, companyId: grant.companyId, assignmentId: grant.assignmentId, resource: 'payment', action: 'read', fieldGroups: ['operational'] });
  if (operator.allowed) return `(${own} or c.state <> 'DRAFT')`;
  const at = `${params.add(grant.at)}::timestamptz`;
  return `(${own} or exists (
             select 1 from approval_instance ri
               join approval_task rt on rt.company_id = ri.company_id and rt.instance_id = ri.id
               join workflow_step rs on rs.company_id = rt.company_id and rs.id = rt.step_id
               join role_assignment rra on rra.company_id = rt.company_id and rra.id = ${params.add(grant.assignmentId)}::uuid
               join role_permission rrp on rrp.company_id = rra.company_id and rrp.role_id = rra.role_id and rrp.permission_id = rs.permission_id and rrp.effect = 'ALLOW'
               join role_assignment_permission rrap on rrap.company_id = rra.company_id and rrap.role_assignment_id = rra.id and rrap.permission_id = rs.permission_id
                    and rrap.active and rrap.effective_from <= ${at} and (rrap.effective_to is null or rrap.effective_to > ${at})
              where ri.company_id = c.company_id and ri.transaction_id = c.transaction_id
                and rt.assignee_user_id = ${params.add(grant.userId)}::uuid and ${taskDelegationLive('rt')}))`;
}

/** claimReadCondition for one claim; row scope over the claimant is the caller's check. */
export async function canReadClaim(db: Queryable, grant: AccessGrant, claimId: string): Promise<boolean> {
  const params = new SqlParams([grant.companyId, claimId]);
  const readable = await claimReadCondition(db, grant, params);
  return ((await db.query(`select 1 from expense_claim c where c.company_id = $1 and c.id = $2 and ${readable}`, params.values)).rowCount ?? 0) > 0;
}

export async function listClaims(db: Queryable, grant: AccessGrant, employeeId: string) {
  if (!(await canAccessEmployee(db, grant, employeeId))) throw notFound();
  const params = new SqlParams([grant.companyId, employeeId]);
  const readable = await claimReadCondition(db, grant, params);
  const rows = await db.query(
    `select c.id, r.purpose, c.state, c.payment_state as "paymentState", c.currency_code as currency, c.current_revision as revision, c.version,
            ${predecessorRequestSql('expense_claim', 'c')} as "predecessorRequestId",
            (select sum(l.claimed_amount) from expense_line l where l.company_id = r.company_id and l.revision_id = r.id)::numeric(19,2)::text as "claimedTotal",
            r.submitted_at as "submittedAt"
       from expense_claim c join expense_revision r on r.company_id = c.company_id and r.claim_id = c.id and r.revision = c.current_revision
      where c.company_id = $1 and c.employee_id = $2 and ${readable} order by c.created_at desc limit 200`,
    params.values,
  );
  return { items: rows.rows };
}

/**
 * One claim and its current revision's lines. `withReasons` says the caller's assignment holds the expense reason group
 * (DF02, DF06): the claimant's justification of a flagged line and the reviewer's clearance reason are then included
 * for a submitted revision. Never for the claimant, in any context: a clearance is a private decision note (DF06).
 */
export async function getClaim(db: Queryable, grant: AccessGrant, claimId: string, withReasons = false) {
  const claim = (
    await db.query<{ id: string; employee_id: string; purpose: string; currency: string; state: string; payment_state: string; current_revision: number; version: number; predecessor_request_id: string | null }>(
      `select c.id, c.employee_id, r.purpose, c.currency_code as currency, c.state, c.payment_state, c.current_revision, c.version,
              ${predecessorRequestSql('expense_claim', 'c')} as predecessor_request_id
         from expense_claim c join expense_revision r on r.company_id = c.company_id and r.claim_id = c.id and r.revision = c.current_revision
        where c.company_id = $1 and c.id = $2`,
      [grant.companyId, claimId],
    )
  ).rows[0];
  if (!claim || !(await canAccessEmployee(db, grant, claim.employee_id))) throw notFound();
  if (!(await canReadClaim(db, grant, claimId))) throw notFound();
  const reasonColumns =
    withReasons && grant.linkedEmployeeId !== claim.employee_id
      ? `, case when r.submitted_at is not null then l.exception_reason end as "exceptionReason",
           (select d.exception_reason from expense_line_decision d where d.company_id = l.company_id and d.line_id = l.id order by d.created_at desc limit 1) as "decisionReason"`
      : '';
  // The claimant correcting a returned claim keeps their own receipts by id (FR-074); nobody else names a receipt file.
  const ownerColumns =
    grant.linkedEmployeeId === claim.employee_id
      ? `, (select er.attachment_id from expense_receipt er where er.company_id = l.company_id and er.line_id = l.id order by er.created_at limit 1) as "receiptId"`
      : '';
  const lines = await db.query(
    `select l.id, l.sequence, c.code as category, l.expense_date as "expenseDate", l.nights, l.merchant, l.invoice_reference as "invoiceReference", l.claimed_amount::text as "claimedAmount",
            l.gross_amount::text as "grossAmount", l.description, l.exception_flags as "exceptionFlags",
            exists (select 1 from expense_receipt r where r.company_id = l.company_id and r.line_id = l.id) as "receiptPresent",
            -- FR-106: attached is not usable; the receipt route serves only a CLEAN file.
            (select a.scan_state from expense_receipt er join attachment a on a.company_id = er.company_id and a.id = er.attachment_id
              where er.company_id = l.company_id and er.line_id = l.id order by er.created_at limit 1) as "receiptScanState",
            -- FR-078: the limit this line was judged under at submission, whatever later revisions say.
            (select pr.limit_amount::text from expense_policy_rule pr where pr.company_id = l.company_id and pr.id = l.applied_rule_id) as "appliedLimit",
            (select d.allowed_amount::text from expense_line_decision d where d.company_id = l.company_id and d.line_id = l.id order by d.created_at desc limit 1) as "approvedAmount"
            ${reasonColumns}${ownerColumns}
       from expense_line l join expense_revision r on r.company_id = l.company_id and r.id = l.revision_id
       join expense_category c on c.company_id = l.company_id and c.id = l.category_id
      where l.company_id = $1 and r.claim_id = $2 and r.revision = $3 order by l.sequence`,
    [grant.companyId, claimId, claim.current_revision],
  );
  // Line 103, FR-072, FR-074: each submitted revision as it was reviewed, with the policy revision it was judged under. A
  // purpose overwritten before revisions kept their own (0117) is null: not recorded.
  const revisions = await db.query(
    `select r.revision, r.purpose, r.submitted_at as "submittedAt", p.code as "policyCode", p.revision as "policyRevision",
            (select sum(l.claimed_amount) from expense_line l where l.company_id = r.company_id and l.revision_id = r.id)::numeric(19,2)::text as "claimedTotal"
       from expense_revision r join expense_policy p on p.company_id = r.company_id and p.id = r.policy_id
      where r.company_id = $1 and r.claim_id = $2 and r.submitted_at is not null order by r.revision`,
    [grant.companyId, claimId],
  );
  const ledger = (
    await db.query<{ approved_amount: string; net_paid: string; pending: string; outstanding: string }>(
      `select approved_amount::text, net_paid::numeric(19,4)::text as net_paid, pending::numeric(19,4)::text as pending,
              (approved_amount - net_paid)::numeric(19,4)::text as outstanding
         from expense_obligation_ledger where company_id = $1 and claim_id = $2`,
      [grant.companyId, claimId],
    )
  ).rows[0];
  return {
    id: claim.id,
    employeeId: claim.employee_id,
    purpose: claim.purpose,
    currency: claim.currency,
    state: claim.state,
    paymentState: claim.payment_state,
    revision: claim.current_revision,
    version: claim.version,
    predecessorRequestId: claim.predecessor_request_id,
    lines: lines.rows,
    revisions: revisions.rows,
    payment: ledger
      ? {
          approvedAmount: ledger.approved_amount,
          netPaid: ledger.net_paid,
          pending: ledger.pending,
          outstanding: ledger.outstanding,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Payments (DF07): manual outcome tracking. Preparer, releaser and the claim's approvers are distinct (DF02, DF03, C4).
// ---------------------------------------------------------------------------------------------------------

/**
 * C5: the claim's payment state derived from its ledger by the database's rule, which it also checks at commit (0088).
 * The claim is locked by its own statement first: the update's snapshot then holds every payment outcome committed
 * before the lock was granted, so two outcomes on one claim at the same moment both derive the true state.
 */
async function refreshPaymentState(tx: Queryable, companyId: string, obligationId: string, actor: string) {
  await tx.query(
    `select 1 from expense_claim c join expense_obligation o on o.company_id = c.company_id and o.claim_id = c.id
      where o.company_id = $1 and o.id = $2 for update of c`,
    [companyId, obligationId],
  );
  await tx.query(
    `update expense_claim c set payment_state = hrms_expense_claim_payment_state(c.company_id, c.id), updated_by = $3
       from expense_obligation o where o.company_id = $1 and o.id = $2 and c.company_id = o.company_id and c.id = o.claim_id`,
    [companyId, obligationId, actor],
  );
}

/**
 * CI06, BR-025: a replacement names the instruction it replaces, which must be an earlier payment of this same liability, definitively
 * failed or cancelled with no live reservation, and not replaced before. Those states are final and the caller holds the obligation's
 * lock, so what is read here stands at commit; the database holds the same rules (0088, 0131).
 */
async function assertReplaceable(tx: Queryable, companyId: string, instructionId: string, obligationId: string) {
  const replaced = (
    await tx.query<{ state: string; retried: boolean }>(
      `select i.state, exists (select 1 from payment_instruction r where r.company_id = i.company_id and r.retry_of_id = i.id) as retried
         from payment_instruction i
         join payment_allocation a on a.company_id = i.company_id and a.instruction_id = i.id and a.obligation_id = $3
        where i.company_id = $1 and i.id = $2`,
      [companyId, instructionId, obligationId],
    )
  ).rows[0];
  if (!replaced) throw new HttpError(422, 'RETRY_NOT_SAME_LIABILITY', 'A replacement replaces an earlier payment of this same claim');
  if (replaced.state !== 'FAILED' && replaced.state !== 'CANCELLED') throw new HttpError(409, 'RETRY_PRIOR_NOT_SETTLED', 'The earlier payment has no definitive failure recorded, so it cannot be replaced yet');
  if (replaced.retried) throw new HttpError(409, 'ALREADY_RETRIED', 'The earlier payment has already been replaced');
}

export async function preparePayment(tx: Queryable, grant: AccessGrant, input: { claimId: string; amount: string; paymentDate: string; idempotencyKey: string; retryOfInstructionId?: string | undefined }) {
  const o = (
    await tx.query<{ id: string; employee_id: string; currency_code: string }>(
      `select id, employee_id, currency_code from expense_obligation where company_id = $1 and claim_id = $2 for update`,
      [grant.companyId, input.claimId],
    )
  ).rows[0];
  if (!o || !(await canAccessEmployee(tx, grant, o.employee_id))) throw notFound();
  // Money moves only under the authority current at commit (docs/09 §6.5), not the one the route guard saw.
  await reassertAccess(tx, grant, 'payment', 'prepare', ['operational']);
  // DF02, C4: whoever approved the entitlement, and the claimant, never prepare its payment; checked before a replay
  // answers, so a key tells them nothing either.
  const conflict = (await tx.query<{ conflict: boolean }>(`select hrms_payment_preparer_conflict($1, $2, $3) as conflict`, [grant.companyId, o.id, grant.userId])).rows[0]!.conflict;
  if (conflict) throw new HttpError(403, 'SEGREGATION_OF_DUTIES', 'The approvers of this entitlement and the claimant cannot prepare its payment');
  // FR-077, DF07: a replay is the same request. A key already used for another claim, amount or date is refused, never
  // answered with the other instruction (the caller would believe this payment had been prepared). Read after the
  // obligation lock, so the same request at the same moment finds the first one's row.
  const prior = (
    await tx.query<{ id: string; state: string; batch_state: string; same: boolean }>(
      `select i.id, i.state, b.state as batch_state, i.amount = $4::numeric and i.payment_date = $5::date and i.retry_of_id is not distinct from $6::uuid
                and exists (select 1 from payment_allocation a where a.company_id = i.company_id and a.instruction_id = i.id and a.obligation_id = $3) as same
         from payment_instruction i join payment_batch b on b.company_id = i.company_id and b.id = i.batch_id
        where i.company_id = $1 and i.idempotency_key = $2`,
      [grant.companyId, input.idempotencyKey, o.id, input.amount, input.paymentDate, input.retryOfInstructionId ?? null],
    )
  ).rows[0];
  if (prior) {
    if (!prior.same) throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', 'This payment key was already used for a different payment');
    return { instructionId: prior.id, state: prior.state, batchState: prior.batch_state, replayed: true };
  }
  if (input.retryOfInstructionId) await assertReplaceable(tx, grant.companyId, input.retryOfInstructionId, o.id);
  const enough = (
    await tx.query<{ ok: boolean }>(
      `select approved_amount - net_paid - pending >= $3::numeric as ok from expense_obligation_ledger where company_id = $1 and obligation_id = $2`,
      [grant.companyId, o.id, input.amount],
    )
  ).rows[0]!.ok;
  if (!enough) throw new HttpError(422, 'EXCEEDS_OUTSTANDING', 'The amount exceeds the unreserved outstanding entitlement');

  const transactionId = (
    await tx.query<{ id: string }>(
      `insert into business_transaction (company_id, kind, state, created_by, updated_by) values ($1, 'payment_batch', 'DRAFT', $2, $2) returning id`,
      [grant.companyId, grant.userId],
    )
  ).rows[0]!.id;
  const batchId = (
    await tx.query<{ id: string }>(
      `insert into payment_batch (company_id, transaction_id, state, prepared_by, currency_code, created_by, updated_by) values ($1, $2, 'DRAFT', $3, $4, $3, $3) returning id`,
      [grant.companyId, transactionId, grant.userId, o.currency_code],
    )
  ).rows[0]!.id;
  const instructionId = (
    await tx.query<{ id: string }>(
      `insert into payment_instruction (company_id, batch_id, employee_id, amount, currency_code, state, idempotency_key, payment_date, retry_of_id, created_by, updated_by)
       values ($1, $2, $3, $4::numeric, $5, 'PREPARED', $6, $7, $9, $8, $8) returning id`,
      [grant.companyId, batchId, o.employee_id, input.amount, o.currency_code, input.idempotencyKey, input.paymentDate, grant.userId, input.retryOfInstructionId ?? null],
    )
  ).rows[0]!.id;
  await tx.query(
    `insert into payment_allocation (company_id, instruction_id, obligation_id, employee_id, currency_code, amount, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6::numeric, $7, $7)`,
    [grant.companyId, instructionId, o.id, o.employee_id, o.currency_code, input.amount, grant.userId],
  );
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'payment_instruction',
    recordKey: instructionId,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'PREPARE',
    newVersion: 1,
    after: { operational: { claimId: input.claimId, amount: input.amount, paymentDate: input.paymentDate, batchState: 'DRAFT', ...(input.retryOfInstructionId ? { retryOfInstructionId: input.retryOfInstructionId } : {}) } },
  });
  return { instructionId, state: 'PREPARED', batchState: 'DRAFT', replayed: false };
}

interface AllocationRow {
  id: string;
  obligation_id: string;
  claim_id: string;
}

interface InstructionRow {
  id: string;
  state: string;
  amount: string;
  batch_id: string;
  batch_state: string;
  batch_transaction_id: string;
  prepared_by: string;
  employee_id: string;
  outcome_actor_id: string | null;
  /** CI05: one instruction may cover several obligations of its employee (the service prepares one). */
  allocations: AllocationRow[];
}

async function lockInstruction(tx: Queryable, grant: AccessGrant, id: string): Promise<InstructionRow> {
  const row = (
    await tx.query<Omit<InstructionRow, 'allocations'>>(
      `select i.id, i.state, i.amount::text, i.batch_id, b.state as batch_state, b.transaction_id as batch_transaction_id, b.prepared_by, i.employee_id, i.outcome_actor_id
         from payment_instruction i
         join payment_batch b on b.company_id = i.company_id and b.id = i.batch_id
        where i.company_id = $1 and i.id = $2 for update of i, b`,
      [grant.companyId, id],
    )
  ).rows[0];
  if (!row || !(await canAccessEmployee(tx, grant, row.employee_id))) throw notFound();
  const allocations = (
    await tx.query<AllocationRow>(
      `select a.id, a.obligation_id, o.claim_id
         from payment_allocation a join expense_obligation o on o.company_id = a.company_id and o.id = a.obligation_id
        where a.company_id = $1 and a.instruction_id = $2 order by a.created_at, a.id`,
      [grant.companyId, id],
    )
  ).rows;
  return { ...row, allocations };
}

/**
 * DF02, DF03, C4: the releaser, and whoever records an outcome or a reversal, differ from the preparer, from every
 * decider of the approval of each allocated claim (the financial reviewer who set its amounts, the final approver and
 * the manager step) and from the claimant. The database holds the rule and checks it again on every write (0088).
 */
async function assertIndependentReleaser(tx: Queryable, grant: AccessGrant, i: InstructionRow) {
  const conflict = (await tx.query<{ conflict: boolean }>(`select hrms_payment_release_conflict($1, $2, $3) as conflict`, [grant.companyId, i.id, grant.userId])).rows[0]!.conflict;
  if (conflict) throw new HttpError(403, 'SEGREGATION_OF_DUTIES', 'The preparer, the approvers of the claim and the claimant cannot release, confirm or reverse this payment');
}

/**
 * C5 "payment batch DRAFT then READY": the draft reserves the amount at preparation; this step offers it for release. C5 names
 * the treasury preparer as this row's actor, and nobody but the person who prepared it can speak for what they prepared.
 */
export async function markPaymentReady(tx: Queryable, grant: AccessGrant, instructionId: string) {
  const i = await lockInstruction(tx, grant, instructionId);
  await reassertAccess(tx, grant, 'payment', 'prepare', ['operational']);
  if (i.prepared_by !== grant.userId) throw new HttpError(403, 'NOT_THE_PREPARER', 'Only the person who prepared this payment can mark it ready');
  if (i.batch_state !== 'DRAFT') throw new HttpError(409, 'INVALID_STATE', 'Only a draft payment can be marked ready');
  await tx.query(`update business_transaction set state = 'READY', updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, i.batch_transaction_id, grant.userId]);
  await tx.query(`update payment_batch set state = 'READY', ready_by = $3, ready_at = now(), updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, i.batch_id, grant.userId]);
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'payment_instruction',
    recordKey: i.id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'READY',
    before: { operational: { batchState: 'DRAFT' } },
    after: { operational: { batchState: 'READY' } },
  });
  return { instructionId: i.id, state: i.state, batchState: 'READY' };
}

/**
 * C3 "confirmation actor explicitly assigned"; DF07 "independent eligible Admin": who may be named to record this instruction's
 * outcome. One assignment must hold the duty and the row scope together (C1 "Combining the action from one assignment with
 * the company scope from another is forbidden"); assigned scope counts only through a task it can decide today; and the
 * release rule (I-49) excludes the preparer, the claim's deciders and the claimant. The releaser is not excluded: DF07 has the
 * releaser confirm, and C3 separates the action, not the person.
 */
async function eligibleOutcomeActors(db: Queryable, companyId: string, instructionId: string, employeeId: string, onlyUserId: string | null) {
  return (
    await db.query<{ userId: string; accountKey: string; employeeCode: string | null; employeeName: string | null }>(
      `with d as (select hrms_business_date($1, now()) as day)
       select distinct u.id as "userId", u.account_key as "accountKey", e.employee_code as "employeeCode", e.display_name as "employeeName"
         from d cross join role_assignment ra
         join user_account u on u.id = ra.user_id and u.active
         join role r on r.company_id = ra.company_id and r.id = ra.role_id and r.active
         join permission p on p.resource = 'payment' and p.action = 'confirm_outcome' and p.field_group = 'operational'
         join role_permission rp on rp.company_id = ra.company_id and rp.role_id = ra.role_id and rp.permission_id = p.id and rp.effect = 'ALLOW'
         join role_assignment_permission rap on rap.company_id = ra.company_id and rap.role_assignment_id = ra.id and rap.permission_id = p.id and rap.active
                                            and rap.effective_from <= now() and (rap.effective_to is null or rap.effective_to > now())
         left join user_employee_link l on l.company_id = ra.company_id and l.user_id = ra.user_id
                                       and l.effective_from <= d.day and (l.effective_to is null or l.effective_to > d.day)
         left join employee e on e.company_id = l.company_id and e.id = l.employee_id
        where ra.company_id = $1 and ra.state = 'ACTIVE' and ra.effective_from <= now() and (ra.effective_to is null or ra.effective_to > now())
          and ($4::uuid is null or ra.user_id = $4)
          and ${scopeCovers('$1', '$3', `exists (select 1 ${eligibleTasksOf({ company: '$1', assignment: 'ra.id', user: 'ra.user_id', at: 'now()' })} and asg_bt.owner_employee_id = $3)`)}
          and not hrms_payment_release_conflict($1, $2, ra.user_id)
        order by "employeeCode" nulls last, "accountKey"`,
      [companyId, instructionId, employeeId, onlyUserId],
    )
  ).rows;
}

/** The people this instruction's outcome can be assigned to, for whoever may release it. */
export async function listOutcomeActors(db: Queryable, grant: AccessGrant, instructionId: string) {
  const i = (await db.query<{ employee_id: string }>(`select employee_id from payment_instruction where company_id = $1 and id = $2`, [grant.companyId, instructionId])).rows[0];
  if (!i || !(await canAccessEmployee(db, grant, i.employee_id))) throw notFound();
  return { items: await eligibleOutcomeActors(db, grant.companyId, instructionId, i.employee_id, null) };
}

async function assertOutcomeActorEligible(tx: Queryable, grant: AccessGrant, i: InstructionRow, userId: string) {
  if ((await eligibleOutcomeActors(tx, grant.companyId, i.id, i.employee_id, userId)).length === 0) {
    throw new HttpError(422, 'OUTCOME_ACTOR_NOT_ELIGIBLE', 'This person cannot be assigned the outcome: they need the confirmation duty over this employee and must be independent of the claim and its preparation');
  }
}

export async function releasePayment(tx: Queryable, grant: AccessGrant, instructionId: string, input: { outcomeActorUserId: string }) {
  const i = await lockInstruction(tx, grant, instructionId);
  await reassertAccess(tx, grant, 'payment', 'release', ['operational']);
  await assertIndependentReleaser(tx, grant, i);
  if (i.state !== 'PREPARED') throw new HttpError(409, 'INVALID_STATE', 'Only prepared instructions can be released');
  if (i.batch_state !== 'READY') throw new HttpError(409, 'BATCH_NOT_READY', 'The preparer has not marked this payment ready yet');
  await assertOutcomeActorEligible(tx, grant, i, input.outcomeActorUserId);
  await tx.query(
    `update payment_instruction set state = 'RELEASED', released_by = $3, outcome_actor_id = $4, outcome_assigned_by = $3, outcome_assigned_at = now(), updated_by = $3 where company_id = $1 and id = $2`,
    [grant.companyId, i.id, grant.userId, input.outcomeActorUserId],
  );
  await tx.query(`update business_transaction set state = 'RELEASED', updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, i.batch_transaction_id, grant.userId]);
  await tx.query(`update payment_batch set state = 'RELEASED', updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, i.batch_id, grant.userId]);
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'payment_instruction',
    recordKey: i.id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'RELEASE',
    after: { operational: { state: 'RELEASED', outcomeActorUserId: input.outcomeActorUserId } },
  });
  return { instructionId: i.id, state: 'RELEASED', outcomeActorUserId: input.outcomeActorUserId };
}

/**
 * Names someone else while the outcome is awaited: the person named can leave, and an instruction released before 0131 names
 * nobody. The BRD does not say who may do this; it stays with the independent release duty, audited with its reason.
 */
export async function assignOutcomeActor(tx: Queryable, grant: AccessGrant, instructionId: string, input: { outcomeActorUserId: string; reason: string }) {
  const i = await lockInstruction(tx, grant, instructionId);
  await reassertAccess(tx, grant, 'payment', 'release', ['operational']);
  await assertIndependentReleaser(tx, grant, i);
  if (i.state !== 'RELEASED') throw new HttpError(409, 'INVALID_STATE', 'Only a released payment waiting for its outcome can be reassigned');
  if (i.outcome_actor_id === input.outcomeActorUserId) throw new HttpError(422, 'NO_CHANGE', 'This person is already assigned the outcome');
  await assertOutcomeActorEligible(tx, grant, i, input.outcomeActorUserId);
  await tx.query(`update payment_instruction set outcome_actor_id = $3, outcome_assigned_by = $4, outcome_assigned_at = now(), updated_by = $4 where company_id = $1 and id = $2`, [
    grant.companyId,
    i.id,
    input.outcomeActorUserId,
    grant.userId,
  ]);
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'payment_instruction',
    recordKey: i.id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'ASSIGN_OUTCOME_ACTOR',
    before: { operational: { outcomeActorUserId: i.outcome_actor_id } },
    after: { operational: { outcomeActorUserId: input.outcomeActorUserId } },
    reason: input.reason,
  });
  return { instructionId: i.id, state: i.state, outcomeActorUserId: input.outcomeActorUserId };
}

/** Confirmed/failed outcome from external evidence; an unknown outcome is simply not recorded (stays RELEASED). */
export async function recordOutcome(tx: Queryable, grant: AccessGrant, instructionId: string, input: { outcome: 'CONFIRMED' | 'FAILED'; evidenceKey: string }) {
  const i = await lockInstruction(tx, grant, instructionId);
  await reassertAccess(tx, grant, 'payment', 'confirm_outcome', ['operational']);
  await assertIndependentReleaser(tx, grant, i);
  // C3 "confirmation actor explicitly assigned": holding the duty is not enough, also on a replay (C5 "authorised outcome actor").
  if (i.outcome_actor_id !== grant.userId) throw new HttpError(403, 'OUTCOME_ACTOR_NOT_ASSIGNED', 'This payment’s outcome is assigned to someone else');
  // A replay is the same outcome of this instruction; any other use of the key is not recorded, and says so (DF07).
  // Read after the instruction lock, so the same outcome at the same moment finds the first one's event.
  const replay = (
    await tx.query<{ event_kind: string; instruction_id: string }>(`select event_kind, instruction_id from payment_event where company_id = $1 and event_key = $2`, [grant.companyId, input.evidenceKey])
  ).rows[0];
  if (replay) {
    if (replay.instruction_id !== i.id || replay.event_kind !== input.outcome) throw new HttpError(409, 'EVIDENCE_KEY_REUSED', 'This evidence key was already used for a different payment event');
    return { instructionId: i.id, state: replay.event_kind, replayed: true };
  }
  if (i.state !== 'RELEASED') throw new HttpError(409, 'INVALID_STATE', 'Only released instructions can receive an outcome');
  const paymentEventId = (
    await tx.query<{ id: string }>(
      `insert into payment_event (company_id, instruction_id, event_key, event_kind, amount, recorded_by, created_by, updated_by)
       values ($1, $2, $3, $4, $5::numeric, $6, $6, $6) returning id`,
      [grant.companyId, i.id, input.evidenceKey, input.outcome, i.amount, grant.userId],
    )
  ).rows[0]!.id;
  await tx.query(`update payment_instruction set state = $3, updated_by = $4 where company_id = $1 and id = $2`, [grant.companyId, i.id, input.outcome, grant.userId]);
  await tx.query(`update business_transaction set state = 'CLOSED', updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, i.batch_transaction_id, grant.userId]);
  await tx.query(`update payment_batch set state = 'CLOSED', updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, i.batch_id, grant.userId]);
  // A definitive failure releases the reservation exactly once (the instruction leaves the pending states); every
  // claim the instruction pays follows its ledger.
  for (const a of i.allocations) await refreshPaymentState(tx, grant.companyId, a.obligation_id, grant.userId);
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'payment_instruction',
    recordKey: i.id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: input.outcome,
    after: { operational: { state: input.outcome } },
  });
  for (const a of i.allocations) await paymentStatusEvent(tx, grant.companyId, a.claim_id, paymentEventId, input.outcome);
  return { instructionId: i.id, state: input.outcome, replayed: false };
}

export async function reversePayment(
  tx: Queryable,
  grant: AccessGrant,
  instructionId: string,
  input: { amount: string; evidenceKey: string; reason: string; claimId?: string | undefined },
) {
  const i = await lockInstruction(tx, grant, instructionId);
  await reassertAccess(tx, grant, 'payment', 'reverse', ['operational']);
  await assertIndependentReleaser(tx, grant, i);
  // FR-077, BR-025, DF07: a replay is this same reversal. A key already used by a confirmation, a failure, another
  // instruction, another amount or another claim is refused: dropping it would leave net paid overstated behind a success.
  // Read after the instruction lock, so the same reversal at the same moment finds the first one's event.
  const replay = (
    await tx.query<{ instruction_id: string; event_kind: string; same_amount: boolean; claim_id: string | null }>(
      `select e.instruction_id, e.event_kind, e.amount = $3::numeric as same_amount,
              (select o.claim_id from payment_allocation a join expense_obligation o on o.company_id = a.company_id and o.id = a.obligation_id
                where a.company_id = e.company_id and a.id = e.allocation_id) as claim_id
         from payment_event e where e.company_id = $1 and e.event_key = $2`,
      [grant.companyId, input.evidenceKey, input.amount],
    )
  ).rows[0];
  if (replay) {
    const same = replay.instruction_id === i.id && replay.event_kind === 'REVERSED' && replay.same_amount && (!input.claimId || replay.claim_id === input.claimId);
    if (!same) throw new HttpError(409, 'EVIDENCE_KEY_REUSED', 'This evidence key was already used for a different payment event');
    return { instructionId: i.id, replayed: true };
  }
  if (i.state !== 'CONFIRMED') throw new HttpError(409, 'INVALID_STATE', 'Only confirmed payments can be reversed');
  // CI06 / DF07: a reversal returns what one claim's allocation was paid and restores only that claim's outstanding. A
  // payment covering several claims (CI05) needs the claim named.
  const allocation = input.claimId ? i.allocations.find((a) => a.claim_id === input.claimId) : i.allocations.length === 1 ? i.allocations[0] : undefined;
  if (!allocation) {
    throw input.claimId
      ? new HttpError(422, 'CLAIM_NOT_COVERED', 'This payment does not pay that claim')
      : new HttpError(422, 'CLAIM_REQUIRED', 'This payment covers several claims; name the claim the reversal returns');
  }
  const confirmation = (
    await tx.query<{ id: string }>(`select id from payment_event where company_id = $1 and instruction_id = $2 and event_kind = 'CONFIRMED'`, [grant.companyId, i.id])
  ).rows[0]!;
  const reversalId = (
    await tx.query<{ id: string }>(
      `insert into payment_event (company_id, instruction_id, allocation_id, event_key, event_kind, amount, reverses_event_id, recorded_by, reason, created_by, updated_by)
       values ($1, $2, $3, $4, 'REVERSED', $5::numeric, $6, $7, $8, $7, $7) returning id`,
      [grant.companyId, i.id, allocation.id, input.evidenceKey, input.amount, confirmation.id, grant.userId, input.reason.trim()],
    )
  ).rows[0]!.id;
  await refreshPaymentState(tx, grant.companyId, allocation.obligation_id, grant.userId);
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'payment_instruction',
    recordKey: i.id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'REVERSE',
    after: { operational: { amount: input.amount, claimId: allocation.claim_id } },
    reason: input.reason,
  });
  await paymentStatusEvent(tx, grant.companyId, allocation.claim_id, reversalId, 'REVERSED');
  return { instructionId: i.id, replayed: false };
}
