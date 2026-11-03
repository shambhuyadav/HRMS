-- 0031 Employee OWN ESS exception (BRD v8.2 H1; BR-053; BR-055; DF02 v8.2; DF06 v8.2).
-- Confidential groups stay Admin/Manager-only, except a narrow, catalogued set that the Employee baseline role
-- may hold in OWN scope for the caller's own record: own private profile values, own submitted reasons, own
-- documents and released receipts, own issued payroll/tax outputs. The catalogue flag below is the complete
-- list; reviewer-private notes (e.g. confirmation reasons) and salary values are deliberately not on it.
alter table permission add column own_ess boolean not null default false;

update permission set own_ess = true
 where (resource, action, field_group) in (
   ('employee', 'read',         'personal'),
   ('leave',    'read',         'reason'),
   ('attendance', 'read',       'reason'),
   ('document', 'read',         'document'),
   ('document', 'upload',       'document'),
   ('expense',  'view_receipt', 'receipt')
 );
