-- 0241 Treasury Operator "Assigned payment preparation tasks" gets its figure (F2; I-84 item 5 defines a payment preparation
-- task; I-83 items 3 and 4 the dashboard rules; decided under owner delegation, 6 Nov 2026, docs/03 I-89 item 2).
--
-- The figure (modules/dashboard/service.ts PAYMENT_PREPARATION_TASKS) counts, in the assignment's organisation scope:
--   approved claims awaiting preparation  FINAL_APPROVED, an outstanding amount and no live reservation
--                                         (GET /v1/expense/payables?awaitingPreparation=true), and
--   draft payments not yet ready          prepared instructions whose batch is still DRAFT
--                                         (GET /v1/expense/payments?state=PREPARED&batchState=DRAFT).
-- Preparing a payment is a duty of an eligible Admin assignment only (DF03, DF07), so the drafts are counted as a state of the
-- scope, whoever prepared them, never as the same person's work in another assignment (DF17 "no merging"). The widget now needs
-- the payment read duty, which opens both lists, so its figure always has a permitted list and stays exact (BR-045).
--
-- Provisioning ensures a widget on its code and never rewrites it, so existing companies need their row moved (as 0120 and 0197
-- did). A widget a company has since pointed elsewhere is left alone. hrms_touch() manages the version and updated_at.
-- To reverse: set metric_code back to 'NOT_YET_AVAILABLE', the title back to 'Assigned payment preparation tasks' and the
-- permission back to dashboard.read.operational on the rows this moved.
update role_dashboard_widget w
   set metric_code = 'PAYMENT_PREPARATION_TASKS',
       title = 'Claims awaiting payment preparation and draft payments not yet ready',
       permission_id = payment.id
  from role_dashboard_definition d
  join role r on r.company_id = d.company_id and r.id = d.role_id
  join permission payment on payment.resource = 'payment' and payment.action = 'read' and payment.field_group = 'operational'
 where d.company_id = w.company_id and d.id = w.dashboard_id and d.dashboard_code = 'HOME'
   and r.code = 'TREASURY_OPERATOR' and w.widget_code = 'MY_TASKS' and w.metric_code = 'NOT_YET_AVAILABLE';
