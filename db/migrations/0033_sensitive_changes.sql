-- 0033 Sensitive private-profile changes (FR-104, FR-105; H2 "Sensitive change"; H4; DB115; DB116; BR-053; BR-054).
-- An employee proposes PERSONAL, ADDRESS or BANK values for their own record (Employee OWN context, H1). An
-- independent eligible HR Administrator verifies the request and its evidence; approval re-checks the base revision
-- and appends one effective-dated revision of the private profile (DB116). Nothing is edited in place: a submitted
-- request is immutable, a correction is a new request that supersedes it. Proposed and approved values are encrypted
-- by the application (AES-256-GCM, each envelope bound to its company, employee and row); the database holds only
-- the envelopes plus the names of the changed fields.

-- DB115 employee_sensitive_change_request. The id is assigned by the application because the envelope is bound to it.
create table employee_sensitive_change_request (
  id                       uuid primary key,
  company_id               uuid not null references company (id) on delete restrict,
  employee_id              uuid not null,
  transaction_kind         text not null default 'sensitive_change' check (transaction_kind = 'sensitive_change'),
  transaction_id           uuid not null,
  category                 text not null check (category in ('PERSONAL', 'ADDRESS', 'BANK')),
  base_revision            integer not null check (base_revision >= 0),
  proposed_effective_date  date not null,
  proposed_payload         text not null check (proposed_payload ~ '^v1\.'),
  changed_fields           text[] not null check (cardinality(changed_fields) between 1 and 20),
  -- The employee's reason is part of the private request (owner and eligible reviewers only).
  reason                   text not null check (btrim(reason) <> '' and length(reason) <= 1000),
  -- H4: the employee-visible explanation of a return or rejection, kept apart from the reviewer's private note.
  employee_message         text check (employee_message is null or (btrim(employee_message) <> '' and length(employee_message) <= 1000)),
  supersedes_request_id    uuid,
  applied_revision_id      uuid,
  state                    text not null check (state in ('DRAFT', 'SUBMITTED', 'IN_REVIEW', 'APPROVED', 'SCHEDULED', 'APPLIED',
                                                          'RETURNED', 'REJECTED', 'WITHDRAWN', 'CONFLICT')),
  submitted_at             timestamptz,
  decided_at               timestamptz,
  applied_at               timestamptz,
  created_at               timestamptz not null default now(),
  created_by               uuid references user_account (id) on delete restrict,
  updated_at               timestamptz not null default now(),
  updated_by               uuid references user_account (id) on delete restrict,
  version                  integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, id, employee_id),
  unique (company_id, id, employee_id, category),
  unique (company_id, transaction_id),
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict,
  foreign key (company_id, transaction_kind, transaction_id) references business_transaction (company_id, kind, id)
    on delete restrict deferrable initially deferred,
  -- DB115: supersedes an earlier request of the same employee and category. The reference is fixed at creation and
  -- can only point at an existing row, so no cycle can form.
  foreign key (company_id, supersedes_request_id, employee_id, category)
    references employee_sensitive_change_request (company_id, id, employee_id, category) on delete restrict,
  check (supersedes_request_id is distinct from id),
  check (state in ('DRAFT', 'WITHDRAWN') or submitted_at is not null),
  check (state <> 'DRAFT' or submitted_at is null),
  check ((state = 'APPLIED') = (applied_revision_id is not null)),
  check ((state = 'APPLIED') = (applied_at is not null))
);
-- One open request per employee and category keeps base revisions unambiguous.
create unique index employee_sensitive_change_one_open on employee_sensitive_change_request (company_id, employee_id, category)
  where (state in ('DRAFT', 'SUBMITTED', 'IN_REVIEW', 'APPROVED', 'SCHEDULED'));
-- A request is superseded by at most one live correction.
create unique index employee_sensitive_change_one_successor on employee_sensitive_change_request (company_id, supersedes_request_id)
  where (supersedes_request_id is not null and state <> 'WITHDRAWN');
create index employee_sensitive_change_employee_idx on employee_sensitive_change_request (company_id, employee_id, created_at desc);
create index employee_sensitive_change_scheduled_idx on employee_sensitive_change_request (company_id, proposed_effective_date)
  where (state = 'SCHEDULED');

-- Identity never changes; once submitted, the proposal, its base, date and reason never change either.
create function hrms_sensitive_change_guard() returns trigger language plpgsql as $$
begin
  if (new.employee_id, new.category, new.transaction_id, new.supersedes_request_id) is distinct from
     (old.employee_id, old.category, old.transaction_id, old.supersedes_request_id) then
    raise exception 'sensitive change identity is immutable' using errcode = '23514';
  end if;
  if old.state <> 'DRAFT' and (new.base_revision, new.proposed_effective_date, new.proposed_payload, new.changed_fields, new.reason)
       is distinct from (old.base_revision, old.proposed_effective_date, old.proposed_payload, old.changed_fields, old.reason) then
    raise exception 'a submitted sensitive change is immutable' using errcode = '23514';
  end if;
  return new;
end $$;

-- Evidence: the requesting employee's own documents, fixed once the request leaves DRAFT.
alter table employee_document add constraint employee_document_company_id_employee_key unique (company_id, id, employee_id);
create table employee_sensitive_change_evidence (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references company (id) on delete restrict,
  request_id   uuid not null,
  employee_id  uuid not null,
  document_id  uuid not null,
  created_at   timestamptz not null default now(),
  created_by   uuid references user_account (id) on delete restrict,
  unique (company_id, request_id, document_id),
  foreign key (company_id, request_id, employee_id) references employee_sensitive_change_request (company_id, id, employee_id) on delete restrict,
  -- CI08: evidence belongs to the same employee as the request.
  foreign key (company_id, document_id, employee_id) references employee_document (company_id, id, employee_id) on delete restrict
);

create function hrms_sensitive_change_evidence_guard() returns trigger language plpgsql as $$
declare
  parent_state text;
begin
  select state into parent_state from employee_sensitive_change_request
   where company_id = coalesce(new.company_id, old.company_id) and id = coalesce(new.request_id, old.request_id);
  if parent_state is distinct from 'DRAFT' then
    raise exception 'evidence of a submitted sensitive change is fixed' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' then
    raise exception 'evidence links are not updated; remove and add instead' using errcode = '23514';
  end if;
  return coalesce(new, old);
end $$;

create trigger employee_sensitive_change_evidence_guard
  before insert or update or delete on employee_sensitive_change_evidence
  for each row execute function hrms_sensitive_change_evidence_guard();

-- DB116 employee_private_profile_revision: the approved private values, one effective-dated revision per
-- application. Rows are immutable apart from closing the interval when a later revision takes effect.
create table employee_private_profile_revision (
  id                 uuid primary key,
  company_id         uuid not null references company (id) on delete restrict,
  employee_id        uuid not null,
  category           text not null check (category in ('PERSONAL', 'ADDRESS', 'BANK')),
  revision           integer not null check (revision > 0),
  effective_from     date not null,
  effective_to       date,
  payload            text not null check (payload ~ '^v1\.'),
  source_request_id  uuid,
  created_at         timestamptz not null default now(),
  created_by         uuid references user_account (id) on delete restrict,
  updated_at         timestamptz not null default now(),
  updated_by         uuid references user_account (id) on delete restrict,
  version            integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, employee_id, category, revision),
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict,
  foreign key (company_id, source_request_id, employee_id, category)
    references employee_sensitive_change_request (company_id, id, employee_id, category) on delete restrict,
  check (effective_to is null or effective_to >= effective_from),
  -- Approved intervals of one category never overlap (an interval superseded on its first day is empty).
  exclude using gist (company_id with =, employee_id with =, category with =, daterange(effective_from, effective_to, '[)') with &&)
);
create unique index employee_private_profile_one_per_request on employee_private_profile_revision (company_id, source_request_id)
  where (source_request_id is not null);

create function hrms_private_profile_revision_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.revision <> coalesce((select max(revision) from employee_private_profile_revision
                                  where company_id = new.company_id and employee_id = new.employee_id and category = new.category), 0) + 1 then
      raise exception 'private profile revisions are consecutive' using errcode = '23514';
    end if;
    return new;
  end if;
  if (new.employee_id, new.category, new.revision, new.effective_from, new.payload, new.source_request_id) is distinct from
     (old.employee_id, old.category, old.revision, old.effective_from, old.payload, old.source_request_id) then
    raise exception 'an approved private profile revision is immutable' using errcode = '23514';
  end if;
  if old.effective_to is not null and new.effective_to is distinct from old.effective_to then
    raise exception 'a closed private profile revision cannot be reopened or moved' using errcode = '23514';
  end if;
  return new;
end $$;

create trigger employee_private_profile_revision_guard
  before insert or update on employee_private_profile_revision
  for each row execute function hrms_private_profile_revision_guard();

alter table employee_sensitive_change_request add constraint employee_sensitive_change_applied_revision_fk
  foreign key (company_id, applied_revision_id) references employee_private_profile_revision (company_id, id) on delete restrict;

create trigger employee_sensitive_change_guard before update on employee_sensitive_change_request
  for each row execute function hrms_sensitive_change_guard();

-- CI12 mirror, checked at commit against the row as it is then: one decision may pass through several states
-- (IN_REVIEW -> APPROVED -> APPLIED), and each queued check must compare the final states, not an intermediate one.
create function hrms_sensitive_change_mirror() returns trigger language plpgsql as $$
declare
  row_state text;
  bt_state text;
begin
  select state into row_state from employee_sensitive_change_request where company_id = new.company_id and id = new.id;
  select state into bt_state from business_transaction where company_id = new.company_id and id = new.transaction_id;
  if bt_state is distinct from row_state then
    raise exception 'sensitive change state % does not match its transaction state %', row_state, bt_state using errcode = '23514';
  end if;
  return null;
end $$;

create constraint trigger employee_sensitive_change_request_mirrors_transaction
  after insert or update on employee_sensitive_change_request deferrable initially deferred
  for each row execute function hrms_sensitive_change_mirror();

do $$
declare
  t text;
begin
  foreach t in array array['employee_sensitive_change_request', 'employee_private_profile_revision'] loop
    execute format('create trigger %I before update on %I for each row execute function hrms_touch()', t || '_touch', t);
  end loop;
  foreach t in array array['employee_sensitive_change_request', 'employee_private_profile_revision'] loop
    execute format('create trigger %I before delete on %I for each row execute function hrms_no_delete()', t || '_no_delete', t);
  end loop;
end $$;

-- H2 sensitive change states. A returned, rejected, withdrawn or conflicting request is final; the employee
-- corrects or rebases it through a new request that supersedes it (renewed approval, no silent overwrite).
insert into transaction_kind (kind, root_table, routing_kind) values ('sensitive_change', 'employee_sensitive_change_request', null);
insert into transaction_state (kind, state, initial, terminal) values
  ('sensitive_change', 'DRAFT',     true,  false),
  ('sensitive_change', 'SUBMITTED', false, false),
  ('sensitive_change', 'IN_REVIEW', false, false),
  ('sensitive_change', 'APPROVED',  false, false),
  ('sensitive_change', 'SCHEDULED', false, false),
  ('sensitive_change', 'APPLIED',   false, true),
  ('sensitive_change', 'RETURNED',  false, true),
  ('sensitive_change', 'REJECTED',  false, true),
  ('sensitive_change', 'WITHDRAWN', false, true),
  ('sensitive_change', 'CONFLICT',  false, true);
insert into transaction_transition (kind, from_state, to_state) values
  ('sensitive_change', 'DRAFT',     'SUBMITTED'),
  ('sensitive_change', 'DRAFT',     'WITHDRAWN'),
  ('sensitive_change', 'SUBMITTED', 'IN_REVIEW'),
  ('sensitive_change', 'SUBMITTED', 'RETURNED'),
  ('sensitive_change', 'SUBMITTED', 'REJECTED'),
  ('sensitive_change', 'SUBMITTED', 'WITHDRAWN'),
  ('sensitive_change', 'SUBMITTED', 'CONFLICT'),
  ('sensitive_change', 'IN_REVIEW', 'APPROVED'),
  ('sensitive_change', 'IN_REVIEW', 'RETURNED'),
  ('sensitive_change', 'IN_REVIEW', 'REJECTED'),
  ('sensitive_change', 'IN_REVIEW', 'WITHDRAWN'),
  ('sensitive_change', 'IN_REVIEW', 'CONFLICT'),
  ('sensitive_change', 'APPROVED',  'SCHEDULED'),
  ('sensitive_change', 'APPROVED',  'APPLIED'),
  ('sensitive_change', 'SCHEDULED', 'APPLIED'),
  ('sensitive_change', 'SCHEDULED', 'CONFLICT');

-- Catalogue. The private and bank groups are confidential (no DB106 operational row). The employee's own request
-- and own approved private values are H1 own-ESS groups; reviewing and full bank values are Admin grants only.
insert into permission (resource, action, field_group, own_ess) values
  ('sensitive_change', 'submit', 'private', true),
  ('sensitive_change', 'read',   'private', true),
  ('sensitive_change', 'review', 'private', false),
  ('employee',         'read',   'private', true),
  ('employee',         'read',   'bank',    false);
