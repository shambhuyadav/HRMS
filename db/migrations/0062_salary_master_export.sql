-- 0062 Salary master exports (FR-029 "salary/annual exports"; E08; CL-208/CL-209; FR-065; DF02; DF09; BR-044).
-- The salary and annual salary exports (report catalogue SALARY_MASTER and ANNUAL_SALARY) carry salary amounts, so
-- they need their own confidential export permission in the salary field group, as the increment exports need
-- increment.export.salary (0015). It is a ceiling-only grant of the HR Administrator role (modules/access/baseline.ts),
-- approved per assignment, never a default duty.
insert into permission (resource, action, field_group) values ('salary', 'export', 'salary');
