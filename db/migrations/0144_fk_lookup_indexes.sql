-- 0144 Lookup indexes (BRD line 4497 "Index FK joins and company/employee/period/state lookup paths"). These are the paths queries,
-- views and triggers actually use; foreign keys to reference masters and actor columns that are never joined stay unindexed.
-- 0088 already covers payment_allocation (company_id, obligation_id) and payment_event (company_id, instruction_id).
-- An index never rejects a stored row, so this cannot stop an upgrade. It does hold writes on each table while it builds (one
-- migration is one transaction, so CONCURRENTLY is not available), so apply it to a large database in a quiet window.

-- Employee: every record of one employee.
create index attachment_employee_idx on attachment (company_id, employee_id);
create index attendance_correction_request_employee_idx on attendance_correction_request (company_id, employee_id);
create index attendance_processing_failure_employee_idx on attendance_processing_failure (company_id, employee_id);
create index attendance_processing_no_policy_employee_idx on attendance_processing_no_policy (company_id, employee_id);
create index biometric_employee_link_employee_idx on biometric_employee_link (company_id, employee_id);
create index biometric_ingest_event_employee_idx on biometric_ingest_event (company_id, employee_id);
create index employee_confirmation_employee_idx on employee_confirmation (company_id, employee_id);
create index employee_document_employee_idx on employee_document (company_id, employee_id);
create index employee_increment_plan_employee_idx on employee_increment_plan (company_id, employee_id);
create index exit_case_employee_idx on exit_case (company_id, employee_id);
create index expense_claim_employee_idx on expense_claim (company_id, employee_id);
create index holiday_work_request_employee_idx on holiday_work_request (company_id, employee_id);
create index increment_plan_change_employee_idx on increment_plan_change (company_id, employee_id);
create index increment_review_exclusion_employee_idx on increment_review_exclusion (company_id, employee_id);
create index leave_request_employee_idx on leave_request (company_id, employee_id);
create index mobile_app_link_employee_idx on mobile_app_link (company_id, employee_id);
create index notification_event_subject_idx on notification_event (company_id, subject_employee_id);
create index outdoor_duty_request_employee_idx on outdoor_duty_request (company_id, employee_id);
create index payment_instruction_employee_idx on payment_instruction (company_id, employee_id);
create index payroll_input_by_employee_idx on payroll_input (company_id, employee_id);
create index payroll_salary_stop_employee_idx on payroll_salary_stop (company_id, employee_id);
create index profile_change_request_employee_idx on profile_change_request (company_id, employee_id);
create index role_scope_filter_employee_idx on role_scope_filter (company_id, employee_id);
create index tax_declaration_employee_idx on tax_declaration (company_id, employee_id);

-- Period and state: a payroll period's input batches, listed by state (payroll/inputs.ts).
create index payroll_input_batch_period_idx on payroll_input_batch (company_id, period_id, state);

-- Joins: from a batch to its instructions, a record to its amendments, a transaction to its notices, a decision to what it decided.
create index payment_instruction_batch_idx on payment_instruction (company_id, batch_id);
create index attendance_amendment_record_idx on attendance_amendment (company_id, attendance_record_id);
create index notification_transaction_idx on notification (company_id, transaction_id);
create index notification_event_transaction_idx on notification_event (company_id, transaction_id);
create index expense_line_decision_decision_idx on expense_line_decision (company_id, approval_decision_id);
create index increment_history_decision_idx on increment_history (company_id, approval_decision_id);
