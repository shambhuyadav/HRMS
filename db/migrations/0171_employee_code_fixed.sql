-- 0171 An employee code never changes once written (DF04 "immutable company-scoped employee code"; "Employee code and company transfer
-- are not in-place edits"; FR-062 "unique business identifiers"). No route edits it, but only that kept the rule: a direct write could
-- rename a record, and a retired code could then be freed for reuse. Nothing stored is read or changed, so this cannot stop an upgrade.
create trigger employee_code_fixed before update of employee_code on employee for each row execute function hrms_columns_fixed('employee_code');
