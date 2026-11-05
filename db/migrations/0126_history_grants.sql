-- 0126 Distinct history grants (C4 "Changed organisation or manager ... Historical financial views require an explicit history
-- grant"; C6 "Add distinct actions for ... confirmation_history_read ... and increment_history_read"; section 11 "Increment
-- cycle and history reports: Salary history grant plus row scope; manager status alone insufficient"; FR-089; FR-090).
--
-- A plain read grant answers for what is in force and later. Earlier salary arrangements, applied increments, closed increment
-- cases' amounts and annual figures need the history grant, so someone newly scoped to an employee, or a new manager, does not
-- get the financial past with the current view. The two financial grants are ceiling-only, approved per assignment like the
-- other salary grants (modules/access/baseline.ts); existing companies need re-provisioning to offer them.
insert into permission (resource, action, field_group) values
  ('salary', 'history_read', 'salary'),
  ('increment', 'history_read', 'salary'),
  ('confirmation', 'history_read', 'operational');
