-- 0054 Company policy documents and bulk document mapping (FR-010; DF02; DF09; FR-106; BR-043; I-13; I-21).
-- A company policy is a company-scoped document with permanent code, title and classification, and an append-only
-- list of versions (each its own quarantined, scanned file with an optional expiry). An OPERATIONAL policy is readable
-- by every employee of its company; a CONFIDENTIAL one needs the confidential grant (DF02). Policies and versions are
-- never deleted, and a version is never changed: a new file is a new version.
-- Bulk document mapping: an authorised user stages employee documents (each quarantined and scanned like every
-- upload), then maps them to employees with an all-or-nothing batch file keyed by file name and employee code; an
-- unknown employee code is a row error, never a silent assignment (FR-010 acceptance). A mapped upload is final.

-- ---------------------------------------------------------------------------
-- Company policies
-- ---------------------------------------------------------------------------
create table company_policy (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references company (id) on delete restrict,
  policy_code     text not null check (policy_code ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  title           text not null check (btrim(title) <> '' and length(title) <= 200),
  classification  text not null check (classification in ('OPERATIONAL', 'CONFIDENTIAL')),
  created_at      timestamptz not null default now(),
  created_by      uuid references user_account (id) on delete restrict,
  updated_at      timestamptz not null default now(),
  updated_by      uuid references user_account (id) on delete restrict,
  version         integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, policy_code)
);

create table company_policy_version (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references company (id) on delete restrict,
  policy_id       uuid not null,
  version_number  integer not null check (version_number > 0),
  attachment_id   uuid not null,
  expires_on      date,
  change_note     text check (change_note is null or (btrim(change_note) <> '' and length(change_note) <= 1000)),
  created_at      timestamptz not null default now(),
  created_by      uuid references user_account (id) on delete restrict,
  updated_at      timestamptz not null default now(),
  updated_by      uuid references user_account (id) on delete restrict,
  version         integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, policy_id, version_number),
  unique (company_id, attachment_id),
  foreign key (company_id, policy_id) references company_policy (company_id, id) on delete restrict,
  foreign key (company_id, attachment_id) references attachment (company_id, id) on delete restrict
);

-- The code is permanent; a policy and its history are never deleted; a version is immutable.
create function hrms_company_policy_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'company policies are kept on record' using errcode = '23514';
  end if;
  if new.policy_code is distinct from old.policy_code or new.company_id is distinct from old.company_id then
    raise exception 'the code of a company policy is permanent' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger company_policy_guard before update or delete on company_policy for each row execute function hrms_company_policy_guard();

create function hrms_company_policy_version_guard() returns trigger language plpgsql as $$
begin
  raise exception 'a policy version is immutable and kept on record; publish a new version' using errcode = '23514';
end $$;
create trigger company_policy_version_guard before update or delete on company_policy_version for each row execute function hrms_company_policy_version_guard();

-- ---------------------------------------------------------------------------
-- Staged documents for bulk mapping
-- ---------------------------------------------------------------------------
create table document_bulk_upload (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references company (id) on delete restrict,
  attachment_id       uuid not null,
  uploaded_by         uuid not null references user_account (id) on delete restrict,
  file_name           text not null check (btrim(file_name) <> '' and length(file_name) <= 255),
  state               text not null check (state in ('UNMAPPED', 'MAPPED')),
  mapped_document_id  uuid,
  mapped_at           timestamptz,
  created_at          timestamptz not null default now(),
  created_by          uuid references user_account (id) on delete restrict,
  updated_at          timestamptz not null default now(),
  updated_by          uuid references user_account (id) on delete restrict,
  version             integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, attachment_id),
  unique (company_id, mapped_document_id),
  foreign key (company_id, attachment_id) references attachment (company_id, id) on delete restrict,
  foreign key (company_id, mapped_document_id) references employee_document (company_id, id) on delete restrict,
  check ((state = 'MAPPED') = (mapped_document_id is not null)),
  check ((mapped_document_id is null) = (mapped_at is null))
);
-- A batch file names each staged document by file name, so one uploader's unmapped names are unique.
create unique index document_bulk_upload_unmapped_name on document_bulk_upload (company_id, uploaded_by, lower(file_name)) where (state = 'UNMAPPED');

-- A staged upload keeps its file and uploader; mapping is final; nothing is deleted.
create function hrms_document_bulk_upload_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'staged documents are kept on record' using errcode = '23514';
  end if;
  if (new.company_id, new.attachment_id, new.uploaded_by, new.file_name) is distinct from (old.company_id, old.attachment_id, old.uploaded_by, old.file_name) then
    raise exception 'the file and uploader of a staged document are fixed' using errcode = '23514';
  end if;
  if old.state = 'MAPPED' and (new.state, new.mapped_document_id, new.mapped_at) is distinct from (old.state, old.mapped_document_id, old.mapped_at) then
    raise exception 'a mapped document is final' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger document_bulk_upload_guard before update or delete on document_bulk_upload for each row execute function hrms_document_bulk_upload_guard();

-- Catalogue. company_policy.operational is classified OPERATIONAL by the module registration; the confidential group
-- has no classification policy and is therefore CONFIDENTIAL (BR-043). Bulk mapping uses document.upload.document.
insert into permission (resource, action, field_group) values
  ('company_policy', 'read',   'operational'),
  ('company_policy', 'read',   'confidential'),
  ('company_policy', 'manage', 'operational'),
  ('company_policy', 'manage', 'confidential');
