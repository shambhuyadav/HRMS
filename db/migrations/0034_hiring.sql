-- 0034 Hiring (FR-011 to FR-014; F1 "Hiring"; DF04 wave 2 minimum form contracts; DB060-DB062; OQ-04; DF02;
-- DF03; DF08; B5 typed transactions). Synthetic data only.
--
-- * Manpower budget (FR-011): an approved staffing headcount per company, department, location, designation and
--   inclusive period. Each change is a revision (its own typed transaction) that an independent HR Administrator
--   approves; the latest approved revision is in force. Budgets hold headcount only: the BRD defines no cost budget.
-- * Requisition (DB060, FR-011/012, F1): requester -> direct manager validation -> HR Administrator budget/headcount
--   approval. F1 states DRAFT/SUBMITTED/APPROVED/REJECTED/CLOSED. Return-for-edit sends a SUBMITTED requisition back
--   to DRAFT (the decision and its reason are kept); resubmission is a new immutable revision with a new approval.
--   Each submission pins its values and budget check in requisition_revision.
-- * Candidate (DB061, FR-013): operational register; private contacts are sealed by the application and matched for
--   duplicates through keyed identity hashes only; CV documents are confidential attachments.
-- * Application (DB062, F1 stages APPLIED/SCREENING/INTERVIEW/OFFER/HIRED/REJECTED/WITHDRAWN): one per candidate and
--   requisition; HIRED only through a handover.
-- * Offer (F1): needs an approved requisition and an independent eligible Admin approval of the confidential
--   compensation (its own typed transaction); immutable revision per submission.
-- * Handover (FR-014): one accepted offer creates at most one DRAFT employee (never activated here), linked back to
--   its requisition, application and candidate.

-- Skills are short trimmed labels (DF02: approved skills are operational).
create function hrms_hiring_skills_valid(s text[]) returns boolean language sql immutable as $$
  select coalesce(bool_and(x is not null and x = btrim(x) and x <> '' and length(x) <= 100), true) from unnest(s) as x
$$;

-- Per-company counters for generated references (REQ-000001, CAN-000001); a copy always takes a new reference.
create table hiring_counter (
  company_id  uuid not null references company (id) on delete restrict,
  counter     text not null check (counter in ('REQUISITION', 'CANDIDATE')),
  last_value  integer not null check (last_value > 0),
  created_at  timestamptz not null default now(),
  created_by  uuid references user_account (id) on delete restrict,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references user_account (id) on delete restrict,
  version     integer not null default 1 check (version > 0),
  primary key (company_id, counter)
);

-- ---------------------------------------------------------------------------------------------------------------
-- FR-011 manpower budget and its revisions
-- ---------------------------------------------------------------------------------------------------------------
create table manpower_budget (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references company (id) on delete restrict,
  department_id   uuid not null,
  location_id     uuid not null,
  designation_id  uuid not null,
  period_start    date not null,
  period_end      date not null,
  created_at      timestamptz not null default now(),
  created_by      uuid references user_account (id) on delete restrict,
  updated_at      timestamptz not null default now(),
  updated_by      uuid references user_account (id) on delete restrict,
  version         integer not null default 1 check (version > 0),
  unique (company_id, id),
  foreign key (company_id, department_id) references department (company_id, id) on delete restrict,
  foreign key (company_id, location_id) references location (company_id, id) on delete restrict,
  foreign key (company_id, designation_id) references designation (company_id, id) on delete restrict,
  check (period_end >= period_start),
  -- One budget line per department, location and designation on any date (inclusive periods).
  exclude using gist (company_id with =, department_id with =, location_id with =, designation_id with =,
                      daterange(period_start, period_end, '[]') with &&)
);

create function hrms_manpower_budget_guard() returns trigger language plpgsql as $$
begin
  if (new.department_id, new.location_id, new.designation_id, new.period_start, new.period_end) is distinct from
     (old.department_id, old.location_id, old.designation_id, old.period_start, old.period_end) then
    raise exception 'a manpower budget line is fixed; record a revision instead' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger manpower_budget_guard before update on manpower_budget for each row execute function hrms_manpower_budget_guard();

create table manpower_budget_revision (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references company (id) on delete restrict,
  budget_id         uuid not null,
  transaction_kind  text not null default 'manpower_budget_revision' check (transaction_kind = 'manpower_budget_revision'),
  transaction_id    uuid not null,
  revision          integer not null check (revision > 0),
  headcount         integer not null check (headcount >= 0),
  reason            text not null check (btrim(reason) <> '' and length(reason) <= 1000),
  state             text not null check (state in ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'WITHDRAWN')),
  prepared_by       uuid not null references user_account (id) on delete restrict,
  submitted_by      uuid references user_account (id) on delete restrict,
  submitted_at      timestamptz,
  decided_by        uuid references user_account (id) on delete restrict,
  decided_at        timestamptz,
  created_at        timestamptz not null default now(),
  created_by        uuid references user_account (id) on delete restrict,
  updated_at        timestamptz not null default now(),
  updated_by        uuid references user_account (id) on delete restrict,
  version           integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, transaction_id),
  unique (company_id, budget_id, revision),
  foreign key (company_id, budget_id) references manpower_budget (company_id, id) on delete restrict,
  foreign key (company_id, transaction_kind, transaction_id) references business_transaction (company_id, kind, id)
    on delete restrict deferrable initially deferred,
  check (state not in ('SUBMITTED', 'APPROVED', 'REJECTED') or (submitted_at is not null and submitted_by is not null)),
  check ((state in ('APPROVED', 'REJECTED')) = (decided_by is not null and decided_at is not null)),
  -- C4/DF02: the deciding HR Administrator is never the preparer or the submitter.
  check (decided_by is null or (decided_by <> prepared_by and decided_by is distinct from submitted_by))
);
create unique index manpower_budget_one_open_revision on manpower_budget_revision (company_id, budget_id)
  where (state in ('DRAFT', 'SUBMITTED'));
create index manpower_budget_revision_approved_idx on manpower_budget_revision (company_id, budget_id, revision desc)
  where (state = 'APPROVED');

create function hrms_manpower_budget_revision_guard() returns trigger language plpgsql as $$
begin
  if (new.budget_id, new.revision, new.transaction_id, new.prepared_by) is distinct from
     (old.budget_id, old.revision, old.transaction_id, old.prepared_by) then
    raise exception 'budget revision identity is immutable' using errcode = '23514';
  end if;
  if old.state <> 'DRAFT' and (new.headcount, new.reason) is distinct from (old.headcount, old.reason) then
    raise exception 'a submitted budget revision is immutable' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger manpower_budget_revision_guard before update on manpower_budget_revision
  for each row execute function hrms_manpower_budget_revision_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- DB060 requisition and its submitted revisions (FR-011, FR-012, F1)
-- ---------------------------------------------------------------------------------------------------------------
create table requisition (
  id                            uuid primary key default gen_random_uuid(),
  company_id                    uuid not null references company (id) on delete restrict,
  code                          text not null check (code ~ '^REQ-[0-9]{6,}$'),
  transaction_kind              text not null default 'requisition' check (transaction_kind = 'requisition'),
  transaction_id                uuid not null,
  requesting_employee_id        uuid not null,
  hiring_manager_id             uuid not null,
  title                         text not null check (btrim(title) <> '' and length(title) <= 200),
  department_id                 uuid not null,
  location_id                   uuid not null,
  designation_id                uuid not null,
  employment_type_category      text not null default 'EMPLOYMENT_TYPE' check (employment_type_category = 'EMPLOYMENT_TYPE'),
  employment_type_id            uuid not null,
  vacancies                     integer not null check (vacancies > 0),
  reason_type                   text not null check (reason_type in ('NEW', 'REPLACEMENT')),
  reason                        text not null check (btrim(reason) <> '' and length(reason) <= 2000),
  skills                        text[] not null default '{}' check (cardinality(skills) <= 50 and hrms_hiring_skills_valid(skills)),
  target_date                   date not null,
  budget_exception_reason       text check (budget_exception_reason is null or (btrim(budget_exception_reason) <> '' and length(budget_exception_reason) <= 2000)),
  copied_from_requisition_id    uuid,
  state                         text not null check (state in ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CLOSED')),
  -- The latest submitted revision (0 until the first submission).
  current_revision              integer not null default 0 check (current_revision >= 0),
  -- The budget line the latest submission or the final approval was checked against.
  budget_id                     uuid,
  submitted_at                  timestamptz,
  decided_by                    uuid references user_account (id) on delete restrict,
  decided_at                    timestamptz,
  budget_exception_approved_by  uuid references user_account (id) on delete restrict,
  budget_exception_approved_at  timestamptz,
  closed_by                     uuid references user_account (id) on delete restrict,
  closed_at                     timestamptz,
  closure_reason                text check (closure_reason is null or (btrim(closure_reason) <> '' and length(closure_reason) <= 1000)),
  created_at                    timestamptz not null default now(),
  created_by                    uuid references user_account (id) on delete restrict,
  updated_at                    timestamptz not null default now(),
  updated_by                    uuid references user_account (id) on delete restrict,
  version                       integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, code),
  unique (company_id, transaction_id),
  foreign key (company_id, transaction_kind, transaction_id) references business_transaction (company_id, kind, id)
    on delete restrict deferrable initially deferred,
  foreign key (company_id, requesting_employee_id) references employee (company_id, id) on delete restrict,
  foreign key (company_id, hiring_manager_id) references employee (company_id, id) on delete restrict,
  foreign key (company_id, department_id) references department (company_id, id) on delete restrict,
  foreign key (company_id, location_id) references location (company_id, id) on delete restrict,
  foreign key (company_id, designation_id) references designation (company_id, id) on delete restrict,
  foreign key (company_id, employment_type_category, employment_type_id) references reference_value (company_id, category, id) on delete restrict,
  foreign key (company_id, budget_id) references manpower_budget (company_id, id) on delete restrict,
  foreign key (company_id, copied_from_requisition_id) references requisition (company_id, id) on delete restrict,
  check (copied_from_requisition_id is distinct from id),
  check (state in ('DRAFT', 'CLOSED') or (current_revision > 0 and submitted_at is not null)),
  check (state not in ('APPROVED', 'REJECTED') or (decided_by is not null and decided_at is not null)),
  check (state not in ('DRAFT', 'SUBMITTED') or decided_by is null),
  check ((state = 'CLOSED') = (closed_at is not null and closed_by is not null and closure_reason is not null)),
  check ((budget_exception_approved_by is null) = (budget_exception_approved_at is null)),
  check (budget_exception_approved_by is null or budget_exception_approved_by = decided_by)
);
create index requisition_state_idx on requisition (company_id, state, created_at desc);
create index requisition_budget_idx on requisition (company_id, budget_id) where (budget_id is not null);
create index requisition_requester_idx on requisition (company_id, requesting_employee_id);
create index requisition_hiring_manager_idx on requisition (company_id, hiring_manager_id);

create function hrms_requisition_guard() returns trigger language plpgsql as $$
begin
  if (new.code, new.transaction_id, new.requesting_employee_id, new.copied_from_requisition_id) is distinct from
     (old.code, old.transaction_id, old.requesting_employee_id, old.copied_from_requisition_id) then
    raise exception 'requisition identity is immutable' using errcode = '23514';
  end if;
  -- Only a draft is edited; a submitted requisition is returned to DRAFT before it can change (F1, DF03).
  if old.state <> 'DRAFT' and (new.title, new.department_id, new.location_id, new.designation_id, new.employment_type_id, new.vacancies,
                               new.reason_type, new.reason, new.skills, new.target_date, new.hiring_manager_id, new.budget_exception_reason)
     is distinct from (old.title, old.department_id, old.location_id, old.designation_id, old.employment_type_id, old.vacancies,
                       old.reason_type, old.reason, old.skills, old.target_date, old.hiring_manager_id, old.budget_exception_reason) then
    raise exception 'a submitted requisition is immutable; return it for edit' using errcode = '23514';
  end if;
  if new.current_revision < old.current_revision then
    raise exception 'requisition revision cannot decrease' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger requisition_guard before update on requisition for each row execute function hrms_requisition_guard();

-- One immutable row per submission: the values and the budget check the approval route decided on.
create table requisition_revision (
  id                        uuid primary key default gen_random_uuid(),
  company_id                uuid not null references company (id) on delete restrict,
  requisition_id            uuid not null,
  revision                  integer not null check (revision > 0),
  title                     text not null,
  department_id             uuid not null,
  location_id               uuid not null,
  designation_id            uuid not null,
  employment_type_category  text not null default 'EMPLOYMENT_TYPE' check (employment_type_category = 'EMPLOYMENT_TYPE'),
  employment_type_id        uuid not null,
  vacancies                 integer not null check (vacancies > 0),
  reason_type               text not null check (reason_type in ('NEW', 'REPLACEMENT')),
  reason                    text not null,
  skills                    text[] not null,
  target_date               date not null,
  hiring_manager_id         uuid not null,
  budget_id                 uuid,
  budget_status             text not null check (budget_status in ('WITHIN_BUDGET', 'EXCEEDS_BUDGET', 'NO_BUDGET')),
  budget_headcount          integer check (budget_headcount >= 0),
  budget_committed          integer not null check (budget_committed >= 0),
  budget_exception_reason   text,
  submitted_by              uuid not null references user_account (id) on delete restrict,
  submitted_at              timestamptz not null default now(),
  created_at                timestamptz not null default now(),
  created_by                uuid references user_account (id) on delete restrict,
  unique (company_id, id),
  unique (company_id, requisition_id, revision),
  foreign key (company_id, requisition_id) references requisition (company_id, id) on delete restrict,
  foreign key (company_id, department_id) references department (company_id, id) on delete restrict,
  foreign key (company_id, location_id) references location (company_id, id) on delete restrict,
  foreign key (company_id, designation_id) references designation (company_id, id) on delete restrict,
  foreign key (company_id, employment_type_category, employment_type_id) references reference_value (company_id, category, id) on delete restrict,
  foreign key (company_id, hiring_manager_id) references employee (company_id, id) on delete restrict,
  foreign key (company_id, budget_id) references manpower_budget (company_id, id) on delete restrict,
  -- FR-011: a requisition beyond its budget (or without one) carries an explicit exception reason.
  check (budget_status = 'WITHIN_BUDGET' or (budget_exception_reason is not null and btrim(budget_exception_reason) <> '')),
  check ((budget_status = 'NO_BUDGET') = (budget_headcount is null)),
  check (budget_status = 'NO_BUDGET' or budget_id is not null)
);

-- ---------------------------------------------------------------------------------------------------------------
-- DB061 candidate register, vendors, private contacts, duplicate review and documents (FR-013)
-- ---------------------------------------------------------------------------------------------------------------
create table recruitment_vendor (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references company (id) on delete restrict,
  code        text not null check (code ~ '^[A-Z0-9][A-Z0-9_-]{0,39}$'),
  name        text not null check (btrim(name) <> '' and length(name) <= 200),
  active      boolean not null,
  created_at  timestamptz not null default now(),
  created_by  uuid references user_account (id) on delete restrict,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references user_account (id) on delete restrict,
  version     integer not null default 1 check (version > 0),
  unique (company_id, code),
  unique (company_id, id)
);

create table candidate (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references company (id) on delete restrict,
  candidate_code       text not null check (candidate_code ~ '^CAN-[0-9]{6,}$'),
  full_name            text not null check (btrim(full_name) <> '' and length(full_name) <= 200),
  source_category      text not null default 'CANDIDATE_SOURCE' check (source_category = 'CANDIDATE_SOURCE'),
  source_id            uuid not null,
  vendor_id            uuid,
  skills               text[] not null default '{}' check (cardinality(skills) <= 50 and hrms_hiring_skills_valid(skills)),
  consent_status       text not null check (consent_status in ('NOT_RECORDED', 'GIVEN', 'WITHDRAWN')),
  consent_recorded_on  date,
  -- Recorded only: no purge runs until a retention schedule is approved (DF08).
  retain_until         date,
  state                text not null check (state in ('ACTIVE', 'INACTIVE', 'DUPLICATE')),
  created_at           timestamptz not null default now(),
  created_by           uuid references user_account (id) on delete restrict,
  updated_at           timestamptz not null default now(),
  updated_by           uuid references user_account (id) on delete restrict,
  version              integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, candidate_code),
  foreign key (company_id, source_category, source_id) references reference_value (company_id, category, id) on delete restrict,
  foreign key (company_id, vendor_id) references recruitment_vendor (company_id, id) on delete restrict,
  check ((consent_status = 'NOT_RECORDED') = (consent_recorded_on is null))
);
create index candidate_state_idx on candidate (company_id, state, candidate_code);

create function hrms_candidate_guard() returns trigger language plpgsql as $$
begin
  if new.candidate_code is distinct from old.candidate_code then
    raise exception 'candidate code is immutable' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger candidate_guard before update on candidate for each row execute function hrms_candidate_guard();

-- Confidential private contacts (DF02, F1): an application-sealed envelope plus keyed identity hashes of the
-- normalised email and phone, so duplicates are found without storing a readable matching key.
create table candidate_contact (
  company_id    uuid not null references company (id) on delete restrict,
  candidate_id  uuid not null,
  payload       text not null check (payload ~ '^v1\.'),
  email_key     text check (email_key ~ '^[0-9a-f]{64}$'),
  phone_key     text check (phone_key ~ '^[0-9a-f]{64}$'),
  created_at    timestamptz not null default now(),
  created_by    uuid references user_account (id) on delete restrict,
  updated_at    timestamptz not null default now(),
  updated_by    uuid references user_account (id) on delete restrict,
  version       integer not null default 1 check (version > 0),
  primary key (company_id, candidate_id),
  foreign key (company_id, candidate_id) references candidate (company_id, id) on delete restrict
);
create index candidate_contact_email_key_idx on candidate_contact (company_id, email_key) where (email_key is not null);
create index candidate_contact_phone_key_idx on candidate_contact (company_id, phone_key) where (phone_key is not null);

-- FR-013: a likely match is flagged for review; records are never merged automatically.
create table candidate_duplicate_flag (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references company (id) on delete restrict,
  candidate_id          uuid not null,
  matched_candidate_id  uuid not null,
  basis                 text not null check (basis in ('EMAIL', 'PHONE')),
  state                 text not null check (state in ('OPEN', 'NOT_DUPLICATE', 'CONFIRMED_DUPLICATE')),
  retired_candidate_id  uuid,
  resolution_note       text check (resolution_note is null or (btrim(resolution_note) <> '' and length(resolution_note) <= 1000)),
  resolved_by           uuid references user_account (id) on delete restrict,
  resolved_at           timestamptz,
  created_at            timestamptz not null default now(),
  created_by            uuid references user_account (id) on delete restrict,
  updated_at            timestamptz not null default now(),
  updated_by            uuid references user_account (id) on delete restrict,
  version               integer not null default 1 check (version > 0),
  unique (company_id, id),
  foreign key (company_id, candidate_id) references candidate (company_id, id) on delete restrict,
  foreign key (company_id, matched_candidate_id) references candidate (company_id, id) on delete restrict,
  foreign key (company_id, retired_candidate_id) references candidate (company_id, id) on delete restrict,
  check (candidate_id <> matched_candidate_id),
  check ((state = 'OPEN') = (resolved_by is null and resolved_at is null)),
  check ((state = 'CONFIRMED_DUPLICATE') = (retired_candidate_id is not null)),
  check (retired_candidate_id is null or retired_candidate_id = candidate_id or retired_candidate_id = matched_candidate_id)
);
-- One flag per pair and basis, whichever record was entered second; a reviewed pair is not flagged again.
create unique index candidate_duplicate_flag_pair on candidate_duplicate_flag
  (company_id, least(candidate_id, matched_candidate_id), greatest(candidate_id, matched_candidate_id), basis);
create index candidate_duplicate_flag_open_idx on candidate_duplicate_flag (company_id, created_at) where (state = 'OPEN');

create function hrms_candidate_duplicate_flag_guard() returns trigger language plpgsql as $$
begin
  if (new.candidate_id, new.matched_candidate_id, new.basis) is distinct from (old.candidate_id, old.matched_candidate_id, old.basis) then
    raise exception 'duplicate flag identity is immutable' using errcode = '23514';
  end if;
  if old.state <> 'OPEN' then
    raise exception 'a reviewed duplicate flag is final' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger candidate_duplicate_flag_guard before update on candidate_duplicate_flag
  for each row execute function hrms_candidate_duplicate_flag_guard();

-- CV and other candidate documents: confidential attachments (no employee yet, so attachment.employee_id is null).
create table candidate_document (
  id                      uuid primary key default gen_random_uuid(),
  company_id              uuid not null references company (id) on delete restrict,
  candidate_id            uuid not null,
  document_type_category  text not null default 'CANDIDATE_DOCUMENT_TYPE' check (document_type_category = 'CANDIDATE_DOCUMENT_TYPE'),
  document_type_id        uuid not null,
  attachment_id           uuid not null,
  created_at              timestamptz not null default now(),
  created_by              uuid references user_account (id) on delete restrict,
  updated_at              timestamptz not null default now(),
  updated_by              uuid references user_account (id) on delete restrict,
  version                 integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, id, candidate_id),
  unique (company_id, attachment_id),
  foreign key (company_id, candidate_id) references candidate (company_id, id) on delete restrict,
  foreign key (company_id, document_type_category, document_type_id) references reference_value (company_id, category, id) on delete restrict,
  foreign key (company_id, attachment_id) references attachment (company_id, id) on delete restrict
);
create index candidate_document_candidate_idx on candidate_document (company_id, candidate_id, created_at desc);

create function hrms_candidate_document_guard() returns trigger language plpgsql as $$
begin
  if (new.candidate_id, new.attachment_id) is distinct from (old.candidate_id, old.attachment_id) then
    raise exception 'candidate document identity is immutable' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger candidate_document_guard before update on candidate_document for each row execute function hrms_candidate_document_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- DB062 application and its stage history (F1 stages)
-- ---------------------------------------------------------------------------------------------------------------
create table application (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references company (id) on delete restrict,
  candidate_id      uuid not null,
  requisition_id    uuid not null,
  stage             text not null check (stage in ('APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED', 'WITHDRAWN')),
  stage_entered_at  timestamptz not null default now(),
  owner_user_id     uuid not null references user_account (id) on delete restrict,
  created_at        timestamptz not null default now(),
  created_by        uuid references user_account (id) on delete restrict,
  updated_at        timestamptz not null default now(),
  updated_by        uuid references user_account (id) on delete restrict,
  version           integer not null default 1 check (version > 0),
  unique (company_id, id),
  -- DB062: one application per candidate and requisition.
  unique (company_id, candidate_id, requisition_id),
  unique (company_id, id, requisition_id, candidate_id),
  foreign key (company_id, candidate_id) references candidate (company_id, id) on delete restrict,
  foreign key (company_id, requisition_id) references requisition (company_id, id) on delete restrict
);
create index application_requisition_idx on application (company_id, requisition_id, stage);
create index application_candidate_idx on application (company_id, candidate_id);

-- ---------------------------------------------------------------------------------------------------------------
-- Offers (F1): approval of the confidential compensation by an independent eligible Admin
-- ---------------------------------------------------------------------------------------------------------------
create table hiring_offer (
  id                     uuid primary key default gen_random_uuid(),
  company_id             uuid not null references company (id) on delete restrict,
  application_id         uuid not null,
  requisition_id         uuid not null,
  candidate_id           uuid not null,
  transaction_kind       text not null default 'hiring_offer' check (transaction_kind = 'hiring_offer'),
  transaction_id         uuid not null,
  proposed_joining_date  date not null,
  state                  text not null check (state in ('DRAFT', 'SUBMITTED', 'APPROVED', 'ACCEPTED', 'DECLINED', 'REJECTED', 'WITHDRAWN')),
  current_revision       integer not null default 0 check (current_revision >= 0),
  prepared_by            uuid not null references user_account (id) on delete restrict,
  submitted_by           uuid references user_account (id) on delete restrict,
  submitted_at           timestamptz,
  compensation_set_by    uuid references user_account (id) on delete restrict,
  decided_by             uuid references user_account (id) on delete restrict,
  decided_at             timestamptz,
  candidate_response_on  date,
  response_recorded_by   uuid references user_account (id) on delete restrict,
  withdrawn_reason       text check (withdrawn_reason is null or (btrim(withdrawn_reason) <> '' and length(withdrawn_reason) <= 1000)),
  withdrawn_by           uuid references user_account (id) on delete restrict,
  withdrawn_at           timestamptz,
  created_at             timestamptz not null default now(),
  created_by             uuid references user_account (id) on delete restrict,
  updated_at             timestamptz not null default now(),
  updated_by             uuid references user_account (id) on delete restrict,
  version                integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, transaction_id),
  unique (company_id, id, application_id, requisition_id, candidate_id),
  foreign key (company_id, application_id, requisition_id, candidate_id)
    references application (company_id, id, requisition_id, candidate_id) on delete restrict,
  foreign key (company_id, transaction_kind, transaction_id) references business_transaction (company_id, kind, id)
    on delete restrict deferrable initially deferred,
  check (state in ('DRAFT', 'WITHDRAWN') or (current_revision > 0 and submitted_by is not null and compensation_set_by is not null)),
  -- F1/C4: the approving Admin is independent of whoever prepared, priced or submitted the offer.
  check (state not in ('APPROVED', 'ACCEPTED', 'DECLINED') or (decided_by is not null and decided_at is not null)),
  check (decided_by is null or (decided_by <> prepared_by and decided_by is distinct from submitted_by and decided_by is distinct from compensation_set_by)),
  check (state not in ('ACCEPTED', 'DECLINED') or (candidate_response_on is not null and response_recorded_by is not null)),
  check ((state = 'WITHDRAWN') = (withdrawn_at is not null and withdrawn_by is not null and withdrawn_reason is not null))
);
-- One live offer per application.
create unique index hiring_offer_one_live on hiring_offer (company_id, application_id) where (state in ('DRAFT', 'SUBMITTED', 'APPROVED', 'ACCEPTED'));
create index hiring_offer_requisition_idx on hiring_offer (company_id, requisition_id, state);
create index hiring_offer_application_idx on hiring_offer (company_id, application_id, created_at desc);
create index candidate_duplicate_flag_matched_idx on candidate_duplicate_flag (company_id, matched_candidate_id);
create index candidate_duplicate_flag_candidate_idx on candidate_duplicate_flag (company_id, candidate_id);

create function hrms_hiring_offer_guard() returns trigger language plpgsql as $$
begin
  if (new.application_id, new.requisition_id, new.candidate_id, new.transaction_id, new.prepared_by) is distinct from
     (old.application_id, old.requisition_id, old.candidate_id, old.transaction_id, old.prepared_by) then
    raise exception 'offer identity is immutable' using errcode = '23514';
  end if;
  if old.state <> 'DRAFT' and new.proposed_joining_date is distinct from old.proposed_joining_date then
    raise exception 'a submitted offer is immutable; return it for edit' using errcode = '23514';
  end if;
  if new.current_revision < old.current_revision then
    raise exception 'offer revision cannot decrease' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger hiring_offer_guard before update on hiring_offer for each row execute function hrms_hiring_offer_guard();

-- The compensation being prepared (confidential group offer.compensation). Changes only while the offer is a draft.
create table hiring_offer_compensation (
  company_id     uuid not null references company (id) on delete restrict,
  offer_id       uuid not null,
  currency_code  text not null check (currency_code ~ '^[A-Z]{3}$'),
  annual_ctc     numeric(19, 4) check (annual_ctc >= 0),
  monthly_gross  numeric(19, 4) check (monthly_gross >= 0),
  set_by         uuid not null references user_account (id) on delete restrict,
  created_at     timestamptz not null default now(),
  created_by     uuid references user_account (id) on delete restrict,
  updated_at     timestamptz not null default now(),
  updated_by     uuid references user_account (id) on delete restrict,
  version        integer not null default 1 check (version > 0),
  primary key (company_id, offer_id),
  foreign key (company_id, offer_id) references hiring_offer (company_id, id) on delete restrict,
  check (num_nonnulls(annual_ctc, monthly_gross) >= 1)
);

create function hrms_hiring_offer_compensation_guard() returns trigger language plpgsql as $$
declare
  parent_state text;
begin
  select state into parent_state from hiring_offer where company_id = new.company_id and id = new.offer_id;
  if parent_state is distinct from 'DRAFT' then
    raise exception 'offer compensation changes only while the offer is a draft' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and new.offer_id is distinct from old.offer_id then
    raise exception 'offer compensation identity is immutable' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger hiring_offer_compensation_guard before insert or update on hiring_offer_compensation
  for each row execute function hrms_hiring_offer_compensation_guard();

-- One immutable row per submission: the terms and compensation the approval decided on.
create table hiring_offer_revision (
  id                     uuid primary key default gen_random_uuid(),
  company_id             uuid not null references company (id) on delete restrict,
  offer_id               uuid not null,
  revision               integer not null check (revision > 0),
  proposed_joining_date  date not null,
  currency_code          text not null check (currency_code ~ '^[A-Z]{3}$'),
  annual_ctc             numeric(19, 4) check (annual_ctc >= 0),
  monthly_gross          numeric(19, 4) check (monthly_gross >= 0),
  compensation_set_by    uuid not null references user_account (id) on delete restrict,
  submitted_by           uuid not null references user_account (id) on delete restrict,
  submitted_at           timestamptz not null default now(),
  created_at             timestamptz not null default now(),
  created_by             uuid references user_account (id) on delete restrict,
  unique (company_id, id),
  unique (company_id, offer_id, revision),
  foreign key (company_id, offer_id) references hiring_offer (company_id, id) on delete restrict,
  check (num_nonnulls(annual_ctc, monthly_gross) >= 1)
);

-- ---------------------------------------------------------------------------------------------------------------
-- FR-014 handover: one accepted offer, one DRAFT employee, traceable to requisition, application and candidate
-- ---------------------------------------------------------------------------------------------------------------
create table hiring_handover (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references company (id) on delete restrict,
  offer_id              uuid not null,
  application_id        uuid not null,
  requisition_id        uuid not null,
  candidate_id          uuid not null,
  employee_id           uuid not null,
  handed_over_by        uuid not null references user_account (id) on delete restrict,
  acting_assignment_id  uuid not null,
  handed_over_at        timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  created_by            uuid references user_account (id) on delete restrict,
  unique (company_id, id),
  unique (company_id, id, candidate_id, employee_id),
  -- The same accepted offer (and application) can never create two employees.
  unique (company_id, offer_id),
  unique (company_id, application_id),
  unique (company_id, employee_id),
  foreign key (company_id, offer_id, application_id, requisition_id, candidate_id)
    references hiring_offer (company_id, id, application_id, requisition_id, candidate_id) on delete restrict,
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict,
  foreign key (company_id, acting_assignment_id) references role_assignment (company_id, id) on delete restrict
);

-- Candidate documents the reviewing Admin approved for onboarding, copied onto the new employee's record.
create table hiring_handover_document (
  id                     uuid primary key default gen_random_uuid(),
  company_id             uuid not null references company (id) on delete restrict,
  handover_id            uuid not null,
  candidate_id           uuid not null,
  employee_id            uuid not null,
  candidate_document_id  uuid not null,
  employee_document_id   uuid not null,
  created_at             timestamptz not null default now(),
  created_by             uuid references user_account (id) on delete restrict,
  unique (company_id, handover_id, candidate_document_id),
  unique (company_id, employee_document_id),
  foreign key (company_id, handover_id, candidate_id, employee_id)
    references hiring_handover (company_id, id, candidate_id, employee_id) on delete restrict,
  foreign key (company_id, candidate_document_id, candidate_id) references candidate_document (company_id, id, candidate_id) on delete restrict,
  foreign key (company_id, employee_document_id, employee_id) references employee_document (company_id, id, employee_id) on delete restrict
);

-- Applications: created APPLIED; forward one stage at a time; REJECTED/WITHDRAWN from any open stage; HIRED only
-- with a recorded handover; final stages are final. The stage start time is set here (tracker ageing).
create function hrms_application_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.stage <> 'APPLIED' then
      raise exception 'an application starts APPLIED' using errcode = '23514';
    end if;
    return new;
  end if;
  if (new.candidate_id, new.requisition_id) is distinct from (old.candidate_id, old.requisition_id) then
    raise exception 'application identity is immutable' using errcode = '23514';
  end if;
  if new.stage is distinct from old.stage then
    if old.stage in ('HIRED', 'REJECTED', 'WITHDRAWN') then
      raise exception 'application in % is final', old.stage using errcode = '23514';
    end if;
    if not ((old.stage, new.stage) in (('APPLIED', 'SCREENING'), ('SCREENING', 'INTERVIEW'), ('INTERVIEW', 'OFFER'), ('OFFER', 'HIRED'))
            or new.stage in ('REJECTED', 'WITHDRAWN')) then
      raise exception 'application stage % -> % is not allowed', old.stage, new.stage using errcode = '23514';
    end if;
    if new.stage = 'HIRED' and not exists (select 1 from hiring_handover where company_id = new.company_id and application_id = new.id) then
      raise exception 'an application becomes HIRED only through a handover' using errcode = '23514';
    end if;
    new.stage_entered_at := now();
  elsif new.stage_entered_at is distinct from old.stage_entered_at then
    raise exception 'stage start time is system-managed' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger application_guard before insert or update on application for each row execute function hrms_application_guard();

create table application_stage_event (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references company (id) on delete restrict,
  application_id        uuid not null,
  from_stage            text check (from_stage in ('APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER')),
  to_stage              text not null check (to_stage in ('APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED', 'WITHDRAWN')),
  note                  text check (note is null or (btrim(note) <> '' and length(note) <= 1000)),
  actor_user_id         uuid not null references user_account (id) on delete restrict,
  acting_assignment_id  uuid,
  occurred_at           timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  created_by            uuid references user_account (id) on delete restrict,
  unique (company_id, id),
  foreign key (company_id, application_id) references application (company_id, id) on delete restrict,
  foreign key (company_id, acting_assignment_id) references role_assignment (company_id, id) on delete restrict,
  -- A rejected or withdrawn application records why.
  check (to_stage not in ('REJECTED', 'WITHDRAWN') or note is not null),
  check ((from_stage is null) = (to_stage = 'APPLIED'))
);
create index application_stage_event_application_idx on application_stage_event (company_id, application_id, occurred_at);

-- ---------------------------------------------------------------------------------------------------------------
-- CI12 mirrors: each typed root's state equals its business_transaction's state at commit, comparing the rows as
-- they are then (one decision may pass through several states).
-- ---------------------------------------------------------------------------------------------------------------
create function hrms_hiring_mirror() returns trigger language plpgsql as $$
declare
  row_state text;
  bt_state text;
begin
  execute format('select state from %I where company_id = $1 and id = $2', tg_table_name) into row_state using new.company_id, new.id;
  select state into bt_state from business_transaction where company_id = new.company_id and id = new.transaction_id;
  if bt_state is distinct from row_state then
    raise exception '% state % does not match its transaction state %', tg_table_name, row_state, bt_state using errcode = '23514';
  end if;
  return null;
end $$;

create constraint trigger requisition_mirrors_transaction after insert or update on requisition
  deferrable initially deferred for each row execute function hrms_hiring_mirror();
create constraint trigger manpower_budget_revision_mirrors_transaction after insert or update on manpower_budget_revision
  deferrable initially deferred for each row execute function hrms_hiring_mirror();
create constraint trigger hiring_offer_mirrors_transaction after insert or update on hiring_offer
  deferrable initially deferred for each row execute function hrms_hiring_mirror();

do $$
declare
  t text;
begin
  foreach t in array array['hiring_counter', 'manpower_budget', 'manpower_budget_revision', 'requisition', 'recruitment_vendor', 'candidate',
                           'candidate_contact', 'candidate_duplicate_flag', 'candidate_document', 'application', 'hiring_offer',
                           'hiring_offer_compensation'] loop
    execute format('create trigger %I before update on %I for each row execute function hrms_touch()', t || '_touch', t);
    execute format('create trigger %I before delete on %I for each row execute function hrms_no_delete()', t || '_no_delete', t);
  end loop;
  -- Submitted revisions, stage history and handovers are append-only (DF08).
  foreach t in array array['requisition_revision', 'hiring_offer_revision', 'application_stage_event', 'hiring_handover', 'hiring_handover_document'] loop
    execute format('create trigger %I before update or delete on %I for each row execute function hrms_append_only()', t || '_append_only', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Typed transactions (B5): states and transitions
-- ---------------------------------------------------------------------------------------------------------------
insert into transaction_kind (kind, root_table, routing_kind) values
  ('requisition', 'requisition', null),
  ('manpower_budget_revision', 'manpower_budget_revision', null),
  ('hiring_offer', 'hiring_offer', null);

-- F1 requisition states. Return-for-edit and withdrawal before a decision go back to DRAFT; an abandoned draft
-- and a finished or cancelled approved requisition are CLOSED (kept, never deleted).
insert into transaction_state (kind, state, initial, terminal) values
  ('requisition', 'DRAFT',     true,  false),
  ('requisition', 'SUBMITTED', false, false),
  ('requisition', 'APPROVED',  false, false),
  ('requisition', 'REJECTED',  false, true),
  ('requisition', 'CLOSED',    false, true),
  ('manpower_budget_revision', 'DRAFT',     true,  false),
  ('manpower_budget_revision', 'SUBMITTED', false, false),
  ('manpower_budget_revision', 'APPROVED',  false, true),
  ('manpower_budget_revision', 'REJECTED',  false, true),
  ('manpower_budget_revision', 'WITHDRAWN', false, true),
  ('hiring_offer', 'DRAFT',     true,  false),
  ('hiring_offer', 'SUBMITTED', false, false),
  ('hiring_offer', 'APPROVED',  false, false),
  ('hiring_offer', 'ACCEPTED',  false, false),
  ('hiring_offer', 'DECLINED',  false, true),
  ('hiring_offer', 'REJECTED',  false, true),
  ('hiring_offer', 'WITHDRAWN', false, true);

insert into transaction_transition (kind, from_state, to_state) values
  ('requisition', 'DRAFT',     'SUBMITTED'),
  ('requisition', 'DRAFT',     'CLOSED'),
  ('requisition', 'SUBMITTED', 'DRAFT'),
  ('requisition', 'SUBMITTED', 'APPROVED'),
  ('requisition', 'SUBMITTED', 'REJECTED'),
  ('requisition', 'APPROVED',  'CLOSED'),
  ('manpower_budget_revision', 'DRAFT',     'SUBMITTED'),
  ('manpower_budget_revision', 'DRAFT',     'WITHDRAWN'),
  ('manpower_budget_revision', 'SUBMITTED', 'APPROVED'),
  ('manpower_budget_revision', 'SUBMITTED', 'REJECTED'),
  ('manpower_budget_revision', 'SUBMITTED', 'WITHDRAWN'),
  ('hiring_offer', 'DRAFT',     'SUBMITTED'),
  ('hiring_offer', 'DRAFT',     'WITHDRAWN'),
  ('hiring_offer', 'SUBMITTED', 'DRAFT'),
  ('hiring_offer', 'SUBMITTED', 'APPROVED'),
  ('hiring_offer', 'SUBMITTED', 'REJECTED'),
  ('hiring_offer', 'SUBMITTED', 'WITHDRAWN'),
  ('hiring_offer', 'APPROVED',  'ACCEPTED'),
  ('hiring_offer', 'APPROVED',  'DECLINED'),
  ('hiring_offer', 'APPROVED',  'WITHDRAWN'),
  ('hiring_offer', 'ACCEPTED',  'WITHDRAWN');

-- ---------------------------------------------------------------------------------------------------------------
-- Permission catalogue (C3 "Appraisal training hiring"). Operational groups are declared by the module registration;
-- candidate.contact, candidate.document and offer.compensation stay confidential (eligible Admin assignments only).
-- ---------------------------------------------------------------------------------------------------------------
insert into permission (resource, action, field_group, own_ess) values
  ('manpower_budget', 'read',     'operational',  false),
  ('manpower_budget', 'manage',   'operational',  false),
  ('manpower_budget', 'approve',  'operational',  false),
  ('requisition',     'read',     'operational',  false),
  ('requisition',     'create',   'operational',  false),
  ('requisition',     'validate', 'operational',  false),
  ('requisition',     'approve',  'operational',  false),
  ('requisition',     'close',    'operational',  false),
  ('candidate',       'read',     'operational',  false),
  ('candidate',       'manage',   'operational',  false),
  ('candidate',       'read',     'contact',      false),
  ('candidate',       'manage',   'contact',      false),
  ('candidate',       'read',     'document',     false),
  ('candidate',       'upload',   'document',     false),
  ('application',     'read',     'operational',  false),
  ('application',     'manage',   'operational',  false),
  ('offer',           'read',     'operational',  false),
  ('offer',           'manage',   'operational',  false),
  ('offer',           'read',     'compensation', false),
  ('offer',           'manage',   'compensation', false),
  ('offer',           'approve',  'compensation', false),
  ('hiring',          'handover', 'operational',  false);
