-- 0120 Task widgets reconcile to their queues (FR-060 "dashboard counts reconcile to the queue"; F2; BR-045).
-- Provisioning ensures a widget on its code and never rewrites it, so existing companies need their rows moved to what
-- modules/dashboard/service.ts now catalogues. Reporting Manager "Assigned leave/expense tasks" counted every pending
-- task of the user, of any kind; it now counts the leave and expense queues only. Treasury Operator "Assigned payment
-- preparation tasks" counted the user's tasks from other assignments; payment preparation has no approval task, so it
-- is shown as not available. A widget a company has since pointed elsewhere is left alone. hrms_touch() manages the
-- version and updated_at of these rows.
update role_dashboard_widget w
   set metric_code = 'LEAVE_EXPENSE_TASKS'
  from role_dashboard_definition d
  join role r on r.company_id = d.company_id and r.id = d.role_id
 where d.company_id = w.company_id and d.id = w.dashboard_id and d.dashboard_code = 'HOME'
   and r.code = 'REPORTING_MANAGER' and w.widget_code = 'MY_TASKS' and w.metric_code = 'MY_OPEN_TASKS';

update role_dashboard_widget w
   set metric_code = 'NOT_YET_AVAILABLE', title = 'Assigned payment preparation tasks'
  from role_dashboard_definition d
  join role r on r.company_id = d.company_id and r.id = d.role_id
 where d.company_id = w.company_id and d.id = w.dashboard_id and d.dashboard_code = 'HOME'
   and r.code = 'TREASURY_OPERATOR' and w.widget_code = 'MY_TASKS' and w.metric_code = 'MY_OPEN_TASKS';
