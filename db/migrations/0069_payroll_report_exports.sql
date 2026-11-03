-- 0069 Payroll report exports (FR-038 payroll register, salary disbursement and comparison; H7 "Payroll freeze
-- register ... confidential export eligible Admin only"; FR-065; DB081; DF02; I-32).
-- The register, disbursement reconciliation and prior-period comparison of a payroll run (report catalogue
-- PAYROLL_REGISTER, PAYROLL_DISBURSEMENT and PAYROLL_COMPARISON) are report exports like every other, so they need
-- their own export permission (view and export rights are configured separately, FR-002, FR-066) on the resource and
-- confidential field group of the JSON reports (payroll_report, amount). Like payroll_report.read.amount (0045) it is
-- a ceiling-only grant of the HR Administrator role while the payroll-outputs module is active
-- (modules/payroll-outputs/registration.ts), approved per assignment, never a default duty.
insert into permission (resource, action, field_group) values ('payroll_report', 'export', 'amount');
