-- 0197 The ordinary finance roles' figures count states, not the same person's Admin tasks (I-83 items 2 and 3; decided under owner
-- delegation, 6 Nov 2026; DF17 "no merging across role assignments"; F2; C7; BR-045; FR-097).
--
-- Provisioning ensures a widget on its code and never rewrites it, so existing companies need their rows moved to what
-- modules/dashboard/service.ts now catalogues (as 0120 did):
--   Finance Reviewer          EXPENSE_REVIEW_TASKS  -> EXPENSE_CLAIMS_IN_REVIEW            claims waiting at any review step in scope
--   Expense Finance Approver  FINAL_DECISIONS       -> EXPENSE_CLAIMS_AWAITING_FINAL       claims waiting for a finance or high-value decision
--                             LATE_RECEIPT          -> EXPENSE_CLAIMS_LATE_RECEIPT         the same with a late or missing-receipt line
--                             RETURNED              -> EXPENSE_CLAIMS_RETURNED_AT_FINANCE  returned at a financial step, awaiting the claimant
--   Payroll Approver          REVIEW_TASKS          -> PAYROLL_RUNS_IN_REVIEW              runs waiting in review
--                             OVERDUE_REVIEWS       -> PAYROLL_RUNS_IN_REVIEW_OVERDUE      the same past the period's payment date
-- The old metrics counted the caller's pending tasks of any assignment; these roles decide nothing in their ordinary context, so
-- that was only ever another assignment's work, or 0. A widget a company has since pointed elsewhere is left alone. hrms_touch()
-- manages the version and updated_at of these rows. To reverse: point the rows back (the old metrics would need restoring in code).
update role_dashboard_widget w
   set metric_code = m.new_metric, title = m.new_title
  from role_dashboard_definition d
  join role r on r.company_id = d.company_id
  join (values
    ('FINANCE_REVIEWER', 'EXPENSE_REVIEW_TASKS', 'EXPENSE_REVIEW_TASKS', 'EXPENSE_CLAIMS_IN_REVIEW', 'Claims in expense review'),
    ('EXPENSE_FINANCE_APPROVER', 'FINAL_DECISIONS', 'EXPENSE_FINAL_DECISION_TASKS', 'EXPENSE_CLAIMS_AWAITING_FINAL', 'Claims awaiting a final decision'),
    ('EXPENSE_FINANCE_APPROVER', 'LATE_RECEIPT', 'EXPENSE_LATE_RECEIPT_EXCEPTIONS', 'EXPENSE_CLAIMS_LATE_RECEIPT', 'Late or missing-receipt claims awaiting a final decision'),
    ('EXPENSE_FINANCE_APPROVER', 'RETURNED', 'EXPENSE_RETURNED_BY_ME', 'EXPENSE_CLAIMS_RETURNED_AT_FINANCE', 'Claims returned at a financial step, awaiting the claimant'),
    ('PAYROLL_APPROVER', 'REVIEW_TASKS', 'PAYROLL_REVIEW_TASKS', 'PAYROLL_RUNS_IN_REVIEW', 'Runs awaiting review or approval'),
    ('PAYROLL_APPROVER', 'OVERDUE_REVIEWS', 'PAYROLL_REVIEW_TASKS_OVERDUE', 'PAYROLL_RUNS_IN_REVIEW_OVERDUE', 'Runs in review past the payment date')
  ) as m (role_code, widget_code, old_metric, new_metric, new_title) on m.role_code = r.code
 where d.company_id = w.company_id and d.id = w.dashboard_id and d.dashboard_code = 'HOME' and r.id = d.role_id
   and w.widget_code = m.widget_code and w.metric_code = m.old_metric;
