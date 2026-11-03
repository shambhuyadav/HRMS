-- 0015 Report executions and outputs (DB081; FR-056, FR-065, FR-079, FR-093; BR-026; DF09; ZT05; ZT17).
-- Generation runs as a worker step under the requester's acting assignment re-checked at generation time; the
-- download re-checks it again. Output content is held in report_output (technical table) until object storage
-- (ADR-07) is configured; the attachment reference is opaque.

-- Report codes follow the upper-case convention of every other business code (0002 used lower case).
alter table report_execution drop constraint report_execution_report_code_check;
alter table report_execution add constraint report_execution_report_code_check check (report_code ~ '^[A-Z][A-Z0-9_]{0,59}$');

alter table report_execution add column row_count integer check (row_count >= 0);
alter table report_execution add column failure_code text;
alter table report_execution add column format text not null default 'CSV' check (format in ('CSV'));

create table report_output (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references company (id) on delete restrict,
  execution_id  uuid not null,
  content       text not null,
  created_at    timestamptz not null default now(),
  unique (company_id, execution_id),
  foreign key (company_id, execution_id) references report_execution (company_id, id) on delete restrict
);
create trigger report_output_append_only before update on report_output for each row execute function hrms_append_only();

insert into permission (resource, action, field_group) values
  ('leave', 'export', 'operational'),
  ('attendance', 'export', 'operational'),
  ('expense', 'export', 'operational'),
  ('increment', 'export', 'salary'),
  ('confirmation', 'export', 'operational');
