-- 0191 Employee record sections: family and dependants, qualifications, prior employment and payroll identifiers (FR-007,
-- FR-008; DF02; DF04; BR-043, BR-044, BR-053, BR-054; H1). Decided under owner delegation, 6 Nov 2026 (docs/03 I-82 item 2,
-- answering I-48 item 3). The field dictionary itself is employee/record-sections.ts. Synthetic data only.
--
-- Classification. DF02 lists none of these values as operational, so each is confidential (BR-043):
--   employee.private     family, qualification and prior-employment values, and the payroll identifiers masked to their
--                        last four characters. The Employee OWN context reads its own (H1/BR-053 "permitted own private
--                        profile values"); an Admin needs the confidential grant on an eligible assignment with row scope.
--   employee.payroll_id  the payroll identifiers in full (DF02 "bank/payment/tax identifiers ... remain confidential").
-- Maintenance belongs to eligible Admins (DF04 "confidential field maintenance belongs to eligible Admins"; BR-054: the
-- employee never changes these directly): employee.manage.private and employee.manage.payroll_id, ceiling only, never on the
-- actor's own record. FR-007 exports of the three list sections: employee.export.private (no export of identifiers).
--
-- Rows are kept (DF08): an entry recorded in error is removed with a reason and stays on record, read only. The payroll
-- identifiers are one application-sealed envelope per employee (AES-256-GCM, security/field-crypto.ts) beside the names of the
-- identifiers it holds; no identifier is stored or audited in clear.
create table employee_family_member (
  id                     uuid primary key default gen_random_uuid(),
  company_id             uuid not null references company (id) on delete restrict,
  employee_id            uuid not null,
  relationship_category  text not null default 'FAMILY_RELATIONSHIP' check (relationship_category = 'FAMILY_RELATIONSHIP'),
  relationship_id        uuid not null,
  full_name              text not null check (full_name = btrim(full_name) and full_name <> '' and length(full_name) <= 200),
  date_of_birth          date,
  dependant              boolean not null default false,
  removed_at             timestamptz,
  removed_by             uuid references user_account (id) on delete restrict,
  removal_reason         text check (removal_reason is null or (btrim(removal_reason) <> '' and length(removal_reason) <= 500)),
  created_at             timestamptz not null default now(),
  created_by             uuid references user_account (id) on delete restrict,
  updated_at             timestamptz not null default now(),
  updated_by             uuid references user_account (id) on delete restrict,
  version                integer not null default 1 check (version > 0),
  unique (company_id, id),
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict,
  foreign key (company_id, relationship_category, relationship_id) references reference_value (company_id, category, id) on delete restrict,
  check ((removed_at is null) = (removed_by is null) and (removed_at is null) = (removal_reason is null))
);
create index employee_family_member_employee_idx on employee_family_member (company_id, employee_id, created_at);

create table employee_qualification (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references company (id) on delete restrict,
  employee_id      uuid not null,
  level_category   text not null default 'QUALIFICATION_LEVEL' check (level_category = 'QUALIFICATION_LEVEL'),
  level_id         uuid not null,
  qualification    text not null check (qualification = btrim(qualification) and qualification <> '' and length(qualification) <= 200),
  specialisation   text check (specialisation is null or (specialisation = btrim(specialisation) and specialisation <> '' and length(specialisation) <= 200)),
  institution      text check (institution is null or (institution = btrim(institution) and institution <> '' and length(institution) <= 200)),
  completion_year  integer check (completion_year is null or completion_year between 1900 and 2200),
  removed_at       timestamptz,
  removed_by       uuid references user_account (id) on delete restrict,
  removal_reason   text check (removal_reason is null or (btrim(removal_reason) <> '' and length(removal_reason) <= 500)),
  created_at       timestamptz not null default now(),
  created_by       uuid references user_account (id) on delete restrict,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references user_account (id) on delete restrict,
  version          integer not null default 1 check (version > 0),
  unique (company_id, id),
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict,
  foreign key (company_id, level_category, level_id) references reference_value (company_id, category, id) on delete restrict,
  check ((removed_at is null) = (removed_by is null) and (removed_at is null) = (removal_reason is null))
);
create index employee_qualification_employee_idx on employee_qualification (company_id, employee_id, created_at);

create table employee_prior_employment (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references company (id) on delete restrict,
  employee_id     uuid not null,
  employer_name   text not null check (employer_name = btrim(employer_name) and employer_name <> '' and length(employer_name) <= 200),
  designation     text check (designation is null or (designation = btrim(designation) and designation <> '' and length(designation) <= 200)),
  from_date       date not null,
  to_date         date not null,
  removed_at      timestamptz,
  removed_by      uuid references user_account (id) on delete restrict,
  removal_reason  text check (removal_reason is null or (btrim(removal_reason) <> '' and length(removal_reason) <= 500)),
  created_at      timestamptz not null default now(),
  created_by      uuid references user_account (id) on delete restrict,
  updated_at      timestamptz not null default now(),
  updated_by      uuid references user_account (id) on delete restrict,
  version         integer not null default 1 check (version > 0),
  unique (company_id, id),
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict,
  -- FR-008 "invalid dates ... fail validation before save": a period never ends before it starts.
  check (to_date >= from_date),
  check ((removed_at is null) = (removed_by is null) and (removed_at is null) = (removal_reason is null))
);
create index employee_prior_employment_employee_idx on employee_prior_employment (company_id, employee_id, from_date);

-- A section entry belongs to one employee for good, and a removed entry is kept exactly as it was removed.
create function hrms_employee_record_section_guard() returns trigger language plpgsql as $$
begin
  if new.employee_id is distinct from old.employee_id then
    raise exception 'a record section entry belongs to one employee' using errcode = '23514';
  end if;
  if old.removed_at is not null then
    raise exception 'a removed record section entry is kept as it was' using errcode = '23514';
  end if;
  return new;
end $$;

create table employee_payroll_identifier (
  company_id   uuid not null references company (id) on delete restrict,
  employee_id  uuid not null,
  payload      text not null check (payload ~ '^v1\.'),
  -- The identifiers the envelope holds (names only), so a reader knows what is recorded without opening it.
  identifiers  text[] not null check (cardinality(identifiers) <= 10 and identifiers <@ array['PAN', 'UAN', 'ESIC_IP']::text[]),
  created_at   timestamptz not null default now(),
  created_by   uuid references user_account (id) on delete restrict,
  updated_at   timestamptz not null default now(),
  updated_by   uuid references user_account (id) on delete restrict,
  version      integer not null default 1 check (version > 0),
  primary key (company_id, employee_id),
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict
);

create function hrms_employee_payroll_identifier_guard() returns trigger language plpgsql as $$
begin
  if new.employee_id is distinct from old.employee_id then
    raise exception 'payroll identifiers belong to one employee' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger employee_payroll_identifier_guard before update on employee_payroll_identifier
  for each row execute function hrms_employee_payroll_identifier_guard();

do $$
declare
  t text;
begin
  foreach t in array array['employee_family_member', 'employee_qualification', 'employee_prior_employment'] loop
    execute format('create trigger %I before update on %I for each row execute function hrms_employee_record_section_guard()', t || '_guard', t);
  end loop;
  foreach t in array array['employee_family_member', 'employee_qualification', 'employee_prior_employment', 'employee_payroll_identifier'] loop
    execute format('create trigger %I before update on %I for each row execute function hrms_touch()', t || '_touch', t);
    execute format('create trigger %I before delete on %I for each row execute function hrms_no_delete()', t || '_no_delete', t);
  end loop;
end $$;

-- Catalogue (none is an own-ESS group: the employee reads their own under the existing employee.read.private).
insert into permission (resource, action, field_group, own_ess) values
  ('employee', 'manage', 'private',    false),
  ('employee', 'read',   'payroll_id', false),
  ('employee', 'manage', 'payroll_id', false),
  ('employee', 'export', 'private',    false);
