// FR-103 / H3 My ESS: the index of all 18 tabs (TN01–TN18) for the employee's own Employee OWN context (BR-055:
// other roles switch to their Employee assignment for their own ESS data). Each tab is AVAILABLE with links to the
// caller's own-record endpoints, NOT_PERMITTED when its module is enabled but this assignment lacks the duty, or
// UNAVAILABLE with a named reason when its module is not enabled yet. An unavailable tab never links anywhere, so a
// disabled module cannot lead to an admin screen; every linked endpoint re-checks access and row scope itself.
import { type Paging, pageOf } from '../../db/paging.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError } from '../../http/errors.js';
import { type AccessGrant, OWN_ESS_ROLE_CODES } from '../access/authorize.js';
import type { PermissionKey } from '../access/baseline.js';
import { assignmentPermissionKeys } from '../access/me.js';
import { OWN_REQUEST_PENDING_STATES } from '../dashboard/service.js';
import { isModuleActive, MODULE_REGISTRATIONS } from '../registry.js';

type Section = 'Personal' | 'Financial' | 'Time and Requests' | 'Development';
interface Link {
  rel: string;
  method: 'GET' | 'POST' | 'PUT';
  href: string;
}

interface CoreTab {
  id: string;
  name: string;
  section: Section;
  /** Available when the assignment holds any of these. */
  permissions?: PermissionKey[];
  links?: Link[];
  /** Served by a registered business module (its essTabs declaration). */
  module?: string;
  /** Not built, or its module not enabled: unavailable with this named reason. */
  unavailable?: { code: string; message: string };
}

const PAYROLL = { code: 'PAYROLL_NOT_ENABLED', message: 'Available once payroll is enabled for your company.' };

/** H3 order and sections. Links use {employeeId} for the caller's own employee. */
export const ESS_TABS: readonly CoreTab[] = [
  {
    id: 'TN01',
    name: 'My Profile',
    section: 'Personal',
    permissions: ['employee.read.operational'],
    links: [
      { rel: 'profile', method: 'GET', href: '/v1/employees/{employeeId}' },
      { rel: 'privateProfile', method: 'GET', href: '/v1/me/private-profile' },
    ],
  },
  {
    id: 'TN02',
    name: 'Personal details change request',
    section: 'Personal',
    permissions: ['sensitive_change.submit.private', 'profile_change.submit.operational'],
    links: [
      { rel: 'requests', method: 'GET', href: '/v1/me/sensitive-changes' },
      { rel: 'createDraft', method: 'POST', href: '/v1/me/sensitive-changes' },
      { rel: 'operationalChanges', method: 'GET', href: '/v1/employees/{employeeId}/profile-changes' },
      { rel: 'requestOperationalChange', method: 'POST', href: '/v1/me/profile-changes' },
      { rel: 'decisionHistory', method: 'GET', href: '/v1/me/requests?kind=sensitive_change' },
    ],
  },
  {
    id: 'TN03',
    name: 'Bank change request',
    section: 'Personal',
    permissions: ['sensitive_change.submit.private'],
    links: [
      { rel: 'maskedBankSummary', method: 'GET', href: '/v1/me/private-profile' },
      { rel: 'requests', method: 'GET', href: '/v1/me/sensitive-changes' },
      { rel: 'createDraft', method: 'POST', href: '/v1/me/sensitive-changes' },
    ],
  },
  {
    id: 'TN04',
    name: 'Address change',
    section: 'Personal',
    permissions: ['sensitive_change.submit.private'],
    links: [
      { rel: 'currentAddress', method: 'GET', href: '/v1/me/private-profile' },
      { rel: 'requests', method: 'GET', href: '/v1/me/sensitive-changes' },
      { rel: 'createDraft', method: 'POST', href: '/v1/me/sensitive-changes' },
    ],
  },
  {
    id: 'TN05',
    name: 'Document upload',
    section: 'Personal',
    permissions: ['document.upload.document', 'document.read.document'],
    links: [
      { rel: 'documents', method: 'GET', href: '/v1/employees/{employeeId}/documents' },
      { rel: 'upload', method: 'POST', href: '/v1/employees/{employeeId}/documents' },
    ],
  },
  { id: 'TN06', name: 'Payslip', section: 'Financial', module: 'payroll-outputs', unavailable: PAYROLL },
  {
    id: 'TN07',
    name: 'Form 16',
    section: 'Financial',
    module: 'payroll-outputs',
    unavailable: { code: 'TAX_CERTIFICATES_NOT_ENABLED', message: 'Available once payroll and the applicable statutory template are enabled.' },
  },
  { id: 'TN08', name: 'Tax declaration', section: 'Financial', module: 'payroll-outputs', unavailable: PAYROLL },
  { id: 'TN09', name: 'Investment proof', section: 'Financial', module: 'payroll-outputs', unavailable: PAYROLL },
  {
    id: 'TN10',
    name: 'Leave',
    section: 'Time and Requests',
    permissions: ['leave.read.operational', 'leave.submit.operational'],
    links: [
      { rel: 'balances', method: 'GET', href: '/v1/employees/{employeeId}/leave-balances' },
      { rel: 'requests', method: 'GET', href: '/v1/employees/{employeeId}/leave-requests' },
      { rel: 'submit', method: 'POST', href: '/v1/leave/requests' },
      { rel: 'decisionHistory', method: 'GET', href: '/v1/me/requests?kind=leave_request' },
    ],
  },
  {
    id: 'TN11',
    name: 'Attendance',
    section: 'Time and Requests',
    permissions: ['attendance.read.operational'],
    links: [{ rel: 'records', method: 'GET', href: '/v1/employees/{employeeId}/attendance' }],
  },
  {
    id: 'TN12',
    name: 'Regularization',
    section: 'Time and Requests',
    permissions: ['attendance.request_correction.operational'],
    links: [
      { rel: 'requests', method: 'GET', href: '/v1/employees/{employeeId}/attendance-corrections' },
      { rel: 'submit', method: 'POST', href: '/v1/me/attendance-corrections' },
      { rel: 'decisionHistory', method: 'GET', href: '/v1/me/requests?kind=attendance_correction' },
    ],
  },
  { id: 'TN13', name: 'Timesheet', section: 'Time and Requests', module: 'timesheet' },
  {
    id: 'TN14',
    name: 'Expense',
    section: 'Time and Requests',
    permissions: ['expense.read.operational', 'expense.draft.operational'],
    links: [
      { rel: 'claims', method: 'GET', href: '/v1/employees/{employeeId}/expense-claims' },
      { rel: 'createDraft', method: 'POST', href: '/v1/expense/claims' },
      { rel: 'decisionHistory', method: 'GET', href: '/v1/me/requests?kind=expense_claim' },
    ],
  },
  {
    id: 'TN15',
    name: 'Loan/advance',
    section: 'Financial',
    module: 'payroll-outputs',
    unavailable: { code: 'LOANS_NOT_ENABLED', message: 'Available once loans and advances are enabled for your company.' },
  },
  {
    id: 'TN16',
    name: 'Assets',
    section: 'Time and Requests',
    module: 'assets',
    unavailable: { code: 'ASSETS_NOT_ENABLED', message: 'Available once asset management is enabled for your company.' },
  },
  { id: 'TN17', name: 'Training', section: 'Development', module: 'training' },
  { id: 'TN18', name: 'Appraisal', section: 'Development', module: 'appraisal' },
];

const MODULE_NOT_ENABLED = (name: string) => ({ code: 'MODULE_NOT_ENABLED', message: `${name} is not enabled for your company yet.` });

/** BR-055: own ESS data is served only in the Employee OWN context; other roles switch to it. */
function ownContext(grant: AccessGrant): string {
  if (!OWN_ESS_ROLE_CODES.includes(grant.roleCode) || grant.scopeKind !== 'OWN' || !grant.linkedEmployeeId) {
    throw new HttpError(403, 'EMPLOYEE_CONTEXT_REQUIRED', 'Select your Employee role to use My ESS');
  }
  return grant.linkedEmployeeId;
}

/** Own requests answered without page/pageSize (the list's cap before it paged). */
export const OWN_REQUEST_LIST_CAP = 200;

/**
 * FR-109 / H3: the employee's own requests of every kind with their state, who they are waiting for and the
 * decision history (decision and time per step), newest first. Reviewer comments are never included (I-16): each
 * module's own view shows what the employee may see of the request itself. FR-056 paging (db/paging.ts): page and
 * pageSize ask for one page; without them the newest OWN_REQUEST_LIST_CAP are answered; `total` counts them all.
 */
export async function ownRequests(db: Queryable, grant: AccessGrant, kind?: string, paging: Paging = {}) {
  const employeeId = ownContext(grant);
  const kinds = Object.keys(OWN_REQUEST_PENDING_STATES).filter((k) => kind === undefined || k === kind);
  const page = await pageOf<{ transactionId: string; kind: string; rootTable: string }>(
    db,
    `select bt.id as "transactionId", bt.kind, bt.state, bt.revision, bt.created_at as "createdAt", bt.updated_at as "updatedAt", tk.root_table as "rootTable",
              (select coalesce(pe.display_name, 'Reviewer')
                 from approval_instance i join approval_task t on t.company_id = i.company_id and t.instance_id = i.id and t.state = 'PENDING'
                 left join user_employee_link l on l.company_id = t.company_id and l.user_id = t.assignee_user_id
                      and l.effective_from <= hrms_business_date(bt.company_id, now()) and (l.effective_to is null or l.effective_to > hrms_business_date(bt.company_id, now()))
                 left join employee pe on pe.company_id = l.company_id and pe.id = l.employee_id
                where i.company_id = bt.company_id and i.transaction_id = bt.id and i.state = 'ACTIVE' limit 1) as "pendingWith",
              coalesce((select json_agg(json_build_object('revision', i.transaction_revision, 'step', s.sequence, 'decision', d.decision, 'decidedAt', d.occurred_at)
                                        order by d.occurred_at)
                          from approval_instance i
                          join approval_task t on t.company_id = i.company_id and t.instance_id = i.id
                          join workflow_step s on s.company_id = t.company_id and s.id = t.step_id
                          join approval_decision d on d.company_id = t.company_id and d.task_id = t.id
                         where i.company_id = bt.company_id and i.transaction_id = bt.id), '[]'::json) as decisions
         from business_transaction bt
         join transaction_kind tk on tk.kind = bt.kind
        where bt.company_id = $1 and bt.owner_employee_id = $2 and bt.kind = any($3::text[])`,
    [grant.companyId, employeeId, kinds],
    '"createdAt" desc, "transactionId" desc',
    paging,
    OWN_REQUEST_LIST_CAP,
  );
  const rows = page.items;
  // The request id within its module (the typed root of each transaction), so a client can open its own view.
  const roots = new Map<string, string>();
  for (const table of new Set(rows.map((r) => r.rootTable))) {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(table)) continue;
    const ids = rows.filter((r) => r.rootTable === table).map((r) => r.transactionId);
    const found = await db.query<{ id: string; transaction_id: string }>(`select id, transaction_id from ${table} where company_id = $1 and transaction_id = any($2::uuid[])`, [
      grant.companyId,
      ids,
    ]);
    for (const f of found.rows) roots.set(f.transaction_id, f.id);
  }
  return { ...page, items: rows.map(({ rootTable: _root, ...r }) => ({ ...r, requestId: roots.get(r.transactionId) ?? null })) };
}

export async function essIndex(db: Queryable, grant: AccessGrant) {
  const employeeId = ownContext(grant);
  const me = (
    await db.query<{ code: string; name: string }>(`select employee_code as code, display_name as name from employee where company_id = $1 and id = $2`, [grant.companyId, employeeId])
  ).rows[0];
  const held = new Set(await assignmentPermissionKeys(db, { companyId: grant.companyId, assignmentId: grant.assignmentId, userId: grant.userId }));
  const own = (links: Link[]) => links.map((l) => ({ ...l, href: l.href.replace('{employeeId}', employeeId) }));

  const tabs = ESS_TABS.map((t) => {
    const base = { id: t.id, name: t.name, section: t.section };
    let permissions = t.permissions ?? [];
    let links = t.links ?? [];
    if (t.module) {
      // A module tab is served once its module is active and declares the tab (registry-types.ts essTabs).
      const declared = isModuleActive(t.module) ? MODULE_REGISTRATIONS.find((m) => m.key === t.module)?.essTabs?.find((e) => e.tab === t.id) : undefined;
      if (!declared) return { ...base, status: 'UNAVAILABLE' as const, unavailable: t.unavailable ?? MODULE_NOT_ENABLED(t.name), links: [] };
      permissions = declared.permissions;
      links = declared.links;
    } else if (t.unavailable) {
      return { ...base, status: 'UNAVAILABLE' as const, unavailable: t.unavailable, links: [] };
    }
    if (!permissions.some((p) => held.has(p))) {
      return { ...base, status: 'NOT_PERMITTED' as const, unavailable: { code: 'NOT_PERMITTED', message: 'Your Employee role does not include this yet; contact HR.' }, links: [] };
    }
    return { ...base, status: 'AVAILABLE' as const, links: own(links) };
  });
  return {
    context: { employeeId, employeeCode: me?.code ?? null, employeeName: me?.name ?? null, roleCode: grant.roleCode, scopeKind: grant.scopeKind },
    tabs,
  };
}
