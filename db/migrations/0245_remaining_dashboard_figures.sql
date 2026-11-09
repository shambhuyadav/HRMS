-- 0245 The remaining F2 dashboard figures get their sources (F2; DF17; BR-045; FR-096; FR-097; DF03; DF07; C5; I-83 items 3 and 4;
-- decided under owner delegation, 6 Nov 2026, docs/03 I-92). Every figure counts records that already exist and links only to a list
-- the viewer may open in the same assignment; none merges another assignment's tasks (DF17) and none widens a grant.
--
-- 1. reporting_setting.expense_decision_due_days (1 to 30; the first revision of every company holds 5): an expense claim's final
--    decision falls due this many business days after the claim reached its financial step (finance or high-value review). DF03
--    escalates a decision after 5 business days, so 5 is the delegated starting value; HR changes it by a dated revision like the
--    other reporting settings (modules/reporting/settings.ts), and a claim keeps the value in force on the day it arrived. The due
--    date is worked out when read (reporting/claim-states.ts); nothing is stored on the task and no escalation or approval changes.
--    The revision trigger now freezes the new value too. The column default only fills existing revisions; the application always
--    names the value it writes.
-- 2. hrms_add_business_days(day, n): the n-th business day after `day`, business days being Monday to Friday, as DF03's reminders
--    and escalations count them (notification/reminders.ts; shift/calendar.ts: no company calendar exists, holidays are per location).
-- 3. Existing companies' widget rows move to what modules/dashboard/service.ts now catalogues (provisioning ensures a widget on its
--    code and never rewrites it, as 0120, 0197 and 0241 did). A row a company has since pointed elsewhere or renamed is left alone:
--      Treasury Operator         RECONCILE            NOT_YET_AVAILABLE -> PAYMENT_RESERVATIONS_TO_RECONCILE, under payment.read
--                                                     (the duty that opens its two payment lists, so the figure stays exact)
--      Finance Reviewer          RECONCILIATION_TASKS, UNRECONCILED_OUTCOMES, EXPENSE_STATES   titles only (same metric codes)
--      Expense Finance Approver  DECISIONS_DUE                                                 title only
--      Recruiter                 INTERVIEWS_DUE                                                title only
--    The Auditor's REVIEW_EVIDENCE stays unavailable: no evidence-review process exists to count (docs/03 I-92).
--    hrms_touch() manages the version and updated_at of these rows.
-- To reverse: point the RECONCILE rows back to NOT_YET_AVAILABLE under dashboard.read.operational with the title 'Reservations needing
-- reconciliation', restore the four old titles, restore hrms_reporting_setting_frozen() from 0196, drop hrms_add_business_days and
-- drop the column (nothing else refers to them once the code no longer reads them).

-- ---------------------------------------------------------------------------------------------------------------
-- 1. The dated due period of an expense final decision
-- ---------------------------------------------------------------------------------------------------------------
alter table reporting_setting
  add column expense_decision_due_days integer not null default 5 check (expense_decision_due_days between 1 and 30);

create or replace function hrms_reporting_setting_frozen() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'reporting settings are kept; close a revision by starting the next one' using errcode = '23514';
  end if;
  if (new.company_id, new.effective_from, new.small_count_threshold, new.recent_activity_days, new.salary_progression_years, new.expense_decision_due_days,
      new.reason, new.created_by, new.created_at)
     is distinct from (old.company_id, old.effective_from, old.small_count_threshold, old.recent_activity_days, old.salary_progression_years, old.expense_decision_due_days,
      old.reason, old.created_by, old.created_at)
     or (old.effective_to is not null and new.effective_to is distinct from old.effective_to) then
    raise exception 'a reporting setting revision is fixed; only an open revision may be given its end date' using errcode = '23514';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Business days (Monday to Friday, DF03)
-- ---------------------------------------------------------------------------------------------------------------
create function hrms_add_business_days(p_day date, p_days integer) returns date language sql immutable strict as $$
  select p_day + g.n
    from generate_series(1, greatest(p_days, 1) * 2 + 7) as g (n)
   where extract(isodow from p_day + g.n) < 6
   order by g.n
  offset greatest(p_days, 1) - 1 limit 1
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Existing companies' widget rows
-- ---------------------------------------------------------------------------------------------------------------
update role_dashboard_widget w
   set metric_code = 'PAYMENT_RESERVATIONS_TO_RECONCILE',
       title = 'Payments past their date still holding a reservation',
       permission_id = payment.id
  from role_dashboard_definition d
  join role r on r.company_id = d.company_id and r.id = d.role_id
  join permission payment on payment.resource = 'payment' and payment.action = 'read' and payment.field_group = 'operational'
 where d.company_id = w.company_id and d.id = w.dashboard_id and d.dashboard_code = 'HOME'
   and r.code = 'TREASURY_OPERATOR' and w.widget_code = 'RECONCILE' and w.metric_code = 'NOT_YET_AVAILABLE';

update role_dashboard_widget w
   set title = m.new_title
  from role_dashboard_definition d
  join role r on r.company_id = d.company_id and r.id = d.role_id
  join (values
    ('FINANCE_REVIEWER', 'RECONCILIATION_TASKS', 'FINANCE_RECONCILIATION_TASKS', 'Reconciliation tasks', 'Claims with a failed or reversed payment still outstanding'),
    ('FINANCE_REVIEWER', 'UNRECONCILED_OUTCOMES', 'FINANCE_UNRECONCILED_OUTCOMES', 'Unreconciled payment outcomes', 'Claims with a released payment whose outcome is not recorded'),
    ('FINANCE_REVIEWER', 'EXPENSE_STATES', 'FINANCE_EXPENSE_STATES', 'Operational expense states', 'Returned / approved claims awaiting payment'),
    ('EXPENSE_FINANCE_APPROVER', 'DECISIONS_DUE', 'EXPENSE_DECISION_DUE_TASKS', 'Decision due tasks', 'Claims whose final decision is due'),
    ('RECRUITER', 'INTERVIEWS_DUE', 'INTERVIEW_TASKS_DUE', 'Interview tasks due', 'Applications you own awaiting interview completion')
  ) as m (role_code, widget_code, metric_code, old_title, new_title) on m.role_code = r.code
 where d.company_id = w.company_id and d.id = w.dashboard_id and d.dashboard_code = 'HOME' and r.id = d.role_id
   and w.widget_code = m.widget_code and w.metric_code = m.metric_code and w.title = m.old_title;
