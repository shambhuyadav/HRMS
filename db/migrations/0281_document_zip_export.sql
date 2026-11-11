-- 0281 Export employee documents to a ZIP (BRD coverage CL-027 "Export Employee Documents to ZIP", under FR-010 documents, FR-057
-- attributable reads, FR-106 released files only; BR-026 row scope; BR-045 export eligibility; DF02). Built 11 Nov 2026 from the
-- reference system's screen (filters: department, document type, employee; a ZIP of the files); decided under owner delegation,
-- 6 Nov 2026.
--
-- document.export.document   exporting employee documents in bulk is a right of its own (FR-002, as settlement.export.amount): the
--                            files are confidential (DF02), so it is a confidential group, ceiling only for the HR Administrator,
--                            granted per assignment, never a default duty. The export also needs the grant the single download
--                            needs (document.read.document) on the same assignment, and keeps to that assignment's row scope.
-- document_export            the export log: who exported, when, with which filters, how many files of how many employees and how
--                            many bytes, and how many matching files were left out because the malware scan has not released them.
--                            Append-only. One audit record per export and one per document it carried (employee_document,
--                            EXPORT_CONTENT), so each document's trail shows it left in an archive.
-- The archive is built in the request and never stored, bounded per export (documents/export.ts: at most 200 files and 50 MB of
-- content); a larger selection is refused with the counts, never cut short.
--
-- To reverse: remove the routes, then drop the table, its trigger and the permission and ceilings added here.

insert into permission (resource, action, field_group) values ('document', 'export', 'document') on conflict do nothing;

create table document_export (
  id                      uuid primary key default gen_random_uuid(),
  company_id              uuid not null references company (id) on delete restrict,
  exported_by             uuid not null references user_account (id) on delete restrict,
  acting_assignment_id    uuid not null,
  exported_at             timestamptz not null default now(),
  -- The filters as given (NULL: not filtered on it).
  department_id           uuid,
  document_type_category  text not null default 'DOCUMENT_TYPE' check (document_type_category = 'DOCUMENT_TYPE'),
  document_type_id        uuid,
  employee_id             uuid,
  document_count          integer not null check (document_count > 0),
  employee_count          integer not null check (employee_count > 0 and employee_count <= document_count),
  byte_size               bigint not null check (byte_size >= 0),
  -- Matching files the malware scan has not released (waiting, quarantined or failed): never in the archive.
  withheld_count          integer not null check (withheld_count >= 0),
  unique (company_id, id),
  foreign key (company_id, acting_assignment_id) references role_assignment (company_id, id) on delete restrict,
  foreign key (company_id, department_id) references department (company_id, id) on delete restrict,
  foreign key (company_id, document_type_category, document_type_id) references reference_value (company_id, category, id) on delete restrict,
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict
);
create index document_export_log_idx on document_export (company_id, exported_at desc);
create index document_export_employee_idx on document_export (company_id, employee_id);
create trigger document_export_append_only before update or delete on document_export for each row execute function hrms_append_only();

-- Ceilings of every company's HR Administrator role (new companies get it from modules/documents/export-registration.ts). A ceiling grants
-- nothing by itself: an assignment holds the group only through an independently approved grant.
insert into role_permission (company_id, role_id, permission_id, effect)
select r.company_id, r.id, p.id, 'ALLOW'
  from role r
  join permission p on p.resource = 'document' and p.action = 'export' and p.field_group = 'document'
 where r.code = 'HR_ADMINISTRATOR'
on conflict (company_id, role_id, permission_id) do nothing;
