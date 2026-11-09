-- 0240 DF16 "Search includes permitted work email/extension" (I-62 item 7, I-83 item 5; decided under owner delegation,
-- 6 Nov 2026, docs/03 I-89 item 5). An optional work phone extension on the employee record: a work contact, operational like
-- the work email (DF02), so it follows the work email's read and change rights (employee.read / employee.update, operational).
-- Digits only, 1 to 8 of them (a desk-phone extension, never a mobile or personal number), no default: existing records have
-- none until HR enters one. The employee and My Team lists show it and their searches match it, as they match the work email.
-- To reverse: remove it from modules/employee and modules/team, then drop the column (no other table refers to it).
alter table employee
  add column work_phone_extension text,
  add constraint employee_work_phone_extension_digits check (work_phone_extension is null or work_phone_extension ~ '^[0-9]{1,8}$');
