-- 0261 Mandatory employee document types and the employee document compliance report (BRD coverage CL-150 "Analytics / Office
-- Reports -> Employee Document Compliance", under FR-056 to FR-058; FR-010 documents; BR-026; BR-044; BR-045; DF02). Built 10 Nov
-- 2026 from the reference screen's structure (company, department, location, employee status filters; employees missing mandatory
-- document types, with counts); decided under owner delegation, 6 Nov 2026.
--
-- document_requirement: which document types (DOCUMENT_TYPE reference values) every employee must hold, for the whole company or
-- for one employment type (EMPLOYMENT_TYPE), each in force over a dated period [effective_from, effective_to). HR keeps it as dated
-- configuration: a requirement starts today or later and is ended (never edited or deleted) from today or later, so the report for
-- an earlier day still reads the rules of that day. A requirement for all employment types and one for a single type may both
-- hold; an employee then needs the document once. The same type is not required twice over overlapping periods for the same
-- employment type (or for all).
--
-- Permissions:
--   document_requirement.read.operational / .manage.operational   default duties of the HR Administrator (the list of required
--                                                                  types is company configuration, not about any one employee);
--   document_compliance.export.document                            the report: which employee lacks which document type is derived
--                                                                  from their confidential documents (DF02), so it needs the same
--                                                                  eligibility as reading them (BR-045): ceiling only, granted per
--                                                                  assignment, never a default duty.
--
-- To reverse: drop the report from the catalogue, then the table, its trigger and the permissions added here.

create table document_requirement (
  id                        uuid primary key default gen_random_uuid(),
  company_id                uuid not null references company (id) on delete restrict,
  document_type_category    text not null default 'DOCUMENT_TYPE' check (document_type_category = 'DOCUMENT_TYPE'),
  document_type_id          uuid not null,
  employment_type_category  text not null default 'EMPLOYMENT_TYPE' check (employment_type_category = 'EMPLOYMENT_TYPE'),
  -- NULL: every employment type.
  employment_type_id        uuid,
  effective_from            date not null,
  -- Exclusive end; equal to the start when a requirement is withdrawn before it began.
  effective_to              date check (effective_to >= effective_from),
  reason                    text not null check (btrim(reason) <> '' and length(reason) <= 1000),
  end_reason                text check (end_reason is null or (btrim(end_reason) <> '' and length(end_reason) <= 1000)),
  created_at                timestamptz not null default now(),
  created_by                uuid not null references user_account (id) on delete restrict,
  acting_assignment_id      uuid not null,
  ended_at                  timestamptz,
  ended_by                  uuid references user_account (id) on delete restrict,
  version                   integer not null default 1 check (version > 0),
  unique (company_id, id),
  foreign key (company_id, document_type_category, document_type_id) references reference_value (company_id, category, id) on delete restrict,
  foreign key (company_id, employment_type_category, employment_type_id) references reference_value (company_id, category, id) on delete restrict,
  foreign key (company_id, acting_assignment_id) references role_assignment (company_id, id) on delete restrict,
  check ((effective_to is null) = (ended_at is null) and (ended_at is null) = (ended_by is null) and (ended_at is null) = (end_reason is null)),
  exclude using gist (
    company_id with =,
    document_type_id with =,
    (coalesce(employment_type_id, '00000000-0000-0000-0000-000000000000'::uuid)) with =,
    daterange(effective_from, effective_to, '[)') with &&
  )
);
create index document_requirement_in_force_idx on document_requirement (company_id, effective_from);

-- Dated configuration: never deleted; only an open requirement's end (with who, when and why) is ever written, once.
create function hrms_document_requirement_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'a document requirement is never deleted; end it instead' using errcode = '23514';
  end if;
  if old.effective_to is not null then
    raise exception 'an ended document requirement is final' using errcode = '23514';
  end if;
  if (new.company_id, new.document_type_id, new.employment_type_id, new.effective_from, new.reason, new.created_at, new.created_by, new.acting_assignment_id)
     is distinct from (old.company_id, old.document_type_id, old.employment_type_id, old.effective_from, old.reason, old.created_at, old.created_by, old.acting_assignment_id) then
    raise exception 'only the end of a document requirement can be recorded' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger document_requirement_guard before update or delete on document_requirement for each row execute function hrms_document_requirement_guard();

insert into permission (resource, action, field_group) values
  ('document_requirement', 'read', 'operational'),
  ('document_requirement', 'manage', 'operational'),
  ('document_compliance', 'export', 'document')
on conflict do nothing;

-- Ceilings of every company's HR Administrator role (new companies get them from modules/documents/registration.ts). New HR
-- Administrator assignments take the two operational duties by default; existing approved assignments keep their frozen allowlists
-- (0099) until a grant adds them. The report's confidential group is never a default duty.
insert into role_permission (company_id, role_id, permission_id, effect)
select r.company_id, r.id, p.id, 'ALLOW'
  from role r
  join permission p on (p.resource, p.action, p.field_group) in (('document_requirement', 'read', 'operational'), ('document_requirement', 'manage', 'operational'),
                                                                   ('document_compliance', 'export', 'document'))
 where r.code = 'HR_ADMINISTRATOR'
on conflict (company_id, role_id, permission_id) do nothing;
