-- 0017 Employee documents and bulk imports (FR-009, FR-010, FR-064; DF02; DF09).
-- File bytes live in the file store (ADR-07); attachment rows hold metadata and an opaque reference.

alter table attachment add column file_name text check (file_name is null or (btrim(file_name) <> '' and length(file_name) <= 255));
alter table attachment add column byte_size integer check (byte_size is null or byte_size between 1 and 10485760);

-- Import jobs record the uploaded file name and an aggregate preview of validation results.
alter table import_job add column file_name text;
alter table import_job add column row_count integer check (row_count >= 0);

insert into permission (resource, action, field_group) values
  ('document', 'upload', 'document'),
  ('document', 'read',   'document'),
  ('employee', 'import', 'operational');
