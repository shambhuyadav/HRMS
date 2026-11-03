-- 0067 Timesheet exports and XLSX report output (FR-046 "search, Export and Export XLSX"; FR-048 TMS reports; FR-065;
-- DB081; DF02; I-30).
-- The resource allocation and TMS hours exports (report catalogue RESOURCE_ALLOCATION and TMS_HOURS) are report
-- exports like every other, so each needs its own export permission on its resource, as leave and attendance exports
-- do (0015): operational, since every timesheet field group is (0037). They are HR Administrator default duties while
-- the timesheet module is active (modules/timesheet/registration.ts), never the reading or report duties themselves.
insert into permission (resource, action, field_group) values
  ('timesheet_allocation', 'export', 'operational'),
  ('timesheet',            'export', 'operational');

-- A report is generated as CSV or, where the report declares it, as an XLSX workbook. CSV stays text in
-- report_output.content; a workbook is binary and is kept in content_bytes. Exactly one of the two is held, and the
-- output stays append-only (0015).
alter table report_execution drop constraint report_execution_format_check;
alter table report_execution add constraint report_execution_format_check check (format in ('CSV', 'XLSX'));

alter table report_output alter column content drop not null;
alter table report_output add column content_bytes bytea;
alter table report_output add constraint report_output_one_content check ((content is null) <> (content_bytes is null));
