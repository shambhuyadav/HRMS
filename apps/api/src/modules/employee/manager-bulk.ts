// Changing several people's manager at once (coverage CL-020 "Upload reporting managers", under FR-003 and FR-009; built 10 Nov 2026
// from the owner's reference system). The file route already exists (EMPLOYEE_UPDATE_V1 has a manager column); this is the screen's
// route: one new manager, one effective date and one reason for a chosen list of people, all or nothing, each through the ordinary
// manager change (changes.ts: scope, own-record refusal, active manager, history, audit, event). People who already report to that
// manager from that day are left as they are and named.
//
// C4 says a task does not move to a new manager by itself. When the caller asks for it explicitly (and holds workflow.reroute_task,
// the HR Administrator's duty), each open approval of a changed person that its assignee can no longer decide is rerouted through
// the ordinary reroute (rerouteOpenTask: the superseded task is kept, the reviewer is whoever selection now finds, the audit carries
// the reason, the new assignee is told). Approvals whose assignee can still decide them (an HR step, say) stay where they are.
// Moving is offered only when the change is already in effect: before that day the old manager still decides.
import type { Queryable } from '../../db/queryable.js';
import { HttpError } from '../../http/errors.js';
import type { AccessGrant } from '../access/authorize.js';
import { rerouteOpenTask } from '../workflow/admin.js';
import { changeManager } from './changes.js';

/** People in one change: the screen pages at this size; a larger move goes through the file import. */
export const MANAGER_BULK_LIMIT = 200;

export interface BulkManagerChange {
  employeeIds: string[];
  managerEmployeeId: string;
  effectiveFrom: string;
  reason: string;
  moveOpenApprovals?: boolean | undefined;
}

export interface BulkManagerResult {
  changed: string[];
  /** Already reporting to that manager from that day: nothing written. */
  unchanged: string[];
  moved: { taskId: string; supersededTaskId: string; ownerEmployeeId: string }[];
  /** Open approvals of the changed people that their assignee can still decide. */
  left: number;
}

export async function changeManagers(tx: Queryable, grant: AccessGrant, input: BulkManagerChange): Promise<BulkManagerResult> {
  const ids = [...new Set(input.employeeIds)];
  if (ids.length !== input.employeeIds.length) throw new HttpError(422, 'VALIDATION_FAILED', 'A person is listed twice');
  if (ids.length === 0 || ids.length > MANAGER_BULK_LIMIT) {
    throw new HttpError(422, 'VALIDATION_FAILED', `Choose between 1 and ${MANAGER_BULK_LIMIT} people; use the employee update import for more`);
  }
  const reason = input.reason.trim();
  if (!reason) throw new HttpError(422, 'REASON_REQUIRED', 'A reason is required');
  if (input.moveOpenApprovals && input.effectiveFrom > grant.businessDate) {
    throw new HttpError(422, 'RULE_VIOLATION', 'Open approvals can move only once the change is in effect: until then the current manager still decides them');
  }
  // A stable order, so two changes over the same people lock them in the same order.
  ids.sort();

  const current = new Map(
    (
      await tx.query<{ employee_id: string; manager_employee_id: string }>(
        `select employee_id, manager_employee_id from manager_assignment
          where company_id = $1 and employee_id = any($2::uuid[])
            and effective_from <= $3::date and (effective_to is null or effective_to > $3::date)`,
        [grant.companyId, ids, input.effectiveFrom],
      )
    ).rows.map((r) => [r.employee_id, r.manager_employee_id]),
  );
  const changed: string[] = [];
  const unchanged: string[] = [];
  for (const id of ids) {
    if (current.get(id) === input.managerEmployeeId) {
      unchanged.push(id);
      continue;
    }
    await changeManager(tx, grant, id, { managerEmployeeId: input.managerEmployeeId, effectiveFrom: input.effectiveFrom, reason });
    changed.push(id);
  }

  const moved: BulkManagerResult['moved'] = [];
  let left = 0;
  if (input.moveOpenApprovals && changed.length > 0) {
    const open = (
      await tx.query<{ id: string; owner: string }>(
        `select t.id, bt.owner_employee_id as owner
           from approval_task t
           join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id and i.state = 'ACTIVE'
           join business_transaction bt on bt.company_id = i.company_id and bt.id = i.transaction_id
          where t.company_id = $1 and t.state = 'PENDING' and bt.owner_employee_id = any($2::uuid[])
          order by t.created_at, t.id`,
        [grant.companyId, changed],
      )
    ).rows;
    for (const task of open) {
      // A task its assignee can still decide is refused by the reroute (TASK_NOT_STRANDED) and stays; the savepoint keeps the
      // rest of the change whatever that refusal touched.
      await tx.query('savepoint manager_move');
      try {
        const r = await rerouteOpenTask(tx, grant, task.id, reason);
        await tx.query('release savepoint manager_move');
        moved.push({ taskId: r.taskId, supersededTaskId: r.supersededTaskId, ownerEmployeeId: task.owner });
      } catch (error) {
        await tx.query('rollback to savepoint manager_move');
        if (error instanceof HttpError && error.code === 'TASK_NOT_STRANDED') {
          left += 1;
          continue;
        }
        throw error;
      }
    }
  }
  return { changed, unchanged, moved, left };
}
