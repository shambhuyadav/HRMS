// DF15 "Review due reminders at 30/7/1 days before closing", for cycle reviews of either basis (DF12 lists increment
// review due as a required event). The closing date is the decision due date each case was opened with. A case still
// waiting for its manager's proposal (DRAFT, RETURNED) raises INCREMENT_PROPOSAL_DUE; a proposal waiting for the
// independent decision (SUBMITTED) raises INCREMENT_DECISION_DUE for the assigned reviewer. Each reminder has its own
// event key (case, due date, lead), so reruns never duplicate; a terminal outcome stops them; nothing here changes a
// case or a salary (BR-041). Event data is the employee's name and code and the dates only: never amounts,
// percentages or reasons.
//
// Run once a day per company, for the company-local date. The scheduler (worker/scheduler.ts) does not call it yet,
// and the in-app rules come from INCREMENT_REVIEW_NOTIFICATIONS (notifications.ts, plain data that provisioning can
// import without this module's runtime dependencies) once that catalogue is provisioned; until then each reminder is
// recorded as a notification event with no recipient.
import { type Database, withTransaction } from '../../db/transaction.js';
import { fanOut } from '../notification/dispatcher.js';
import { INCREMENT_REVIEW_NOTIFICATIONS, INCREMENT_REVIEW_REMINDER_LEAD_DAYS } from './notifications.js';

export { INCREMENT_REVIEW_NOTIFICATIONS, INCREMENT_REVIEW_REMINDER_LEAD_DAYS };

/**
 * Raises the reminders due on `day` (company-local, default today) for one company. The signature fits a daily job
 * (db, companyId, localDate, systemUserId); no user id is needed because nothing is changed on anyone's behalf.
 */
export async function runIncrementReviewReminders(db: Database, companyId: string, day?: string, _systemUserId?: string) {
  return withTransaction(db, async (tx) => {
    const today = day ?? (await tx.query<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [companyId])).rows[0]!.d;
    const due = (
      await tx.query<{ id: string; employee_id: string; transaction_id: string; state: string; name: string; code: string; due: string; days: number; task_id: string | null }>(
        `select c.id, c.employee_id, c.transaction_id, c.state, e.display_name as name, e.employee_code as code,
                to_char(c.decision_due_on, 'YYYY-MM-DD') as due, (c.decision_due_on - $2::date)::int as days,
                (select t.id from approval_task t
                   join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id and i.state = 'ACTIVE'
                  where i.company_id = c.company_id and i.transaction_id = c.transaction_id and t.state = 'PENDING'
                  order by t.created_at desc limit 1) as task_id
           from increment_case c join employee e on e.company_id = c.company_id and e.id = c.employee_id
          where c.company_id = $1 and not c.off_cycle and c.state in ('DRAFT', 'SUBMITTED', 'RETURNED')
            and c.decision_due_on - $2::date = any ($3::int[])
          order by c.id`,
        [companyId, today, [...INCREMENT_REVIEW_REMINDER_LEAD_DAYS]],
      )
    ).rows;
    let events = 0;
    let notifications = 0;
    for (const c of due) {
      const eventType = c.state === 'SUBMITTED' ? 'INCREMENT_DECISION_DUE' : 'INCREMENT_PROPOSAL_DUE';
      const result = await fanOut(tx, companyId, `${eventType}:${c.id}:${c.due}:${c.days}`, today, {
        eventType,
        fallbackKind: 'increment_case',
        subjectEmployeeId: c.employee_id,
        transactionId: c.transaction_id,
        transactionRevision: null,
        taskId: c.state === 'SUBMITTED' ? c.task_id : null,
        beneficiaryUserId: null,
        data: { employeeName: c.name, employeeCode: c.code, dueDate: c.due, days: String(c.days) },
      });
      if (result.recorded) events++;
      notifications += result.created;
    }
    return { day: today, events, notifications };
  });
}
