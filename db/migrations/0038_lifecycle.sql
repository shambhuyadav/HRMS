-- 0038 Employee lifecycle processes, exit, letters and restricted notes
-- (FR-015, FR-016, FR-017, FR-018, FR-051, FR-055; DB075-DB078; F1 "Exit and employee processes"; BR-016; BR-027;
-- DF02 access/confidentiality; DF03 routing and states; DF04 process/exit contracts; DF08 history; DF09 outputs;
-- DF12 notifications; CI11; CI12; CI14; CI15).
--
-- * Process templates (DB075) are HR-controlled and revisioned: a DRAFT revision is edited, publishing freezes it
--   and retires the previous published one. An employee process (DB076, typed root) copies the tasks of the
--   revision published when it starts, so later template changes never rewrite an instance.
-- * An exit case (DB078, typed root) is the employee's resignation: the direct manager recommends the last working
--   date, an independent HR Administrator approves it (inclusive date). One open exit per employee. Withdrawal is
--   the employee's before the final decision; afterwards it is a separate request (exit_withdrawal) that an
--   independent HR Administrator decides. Nothing is deleted; every step is kept in exit_case_event.
-- * Letters (DB077): versioned templates with approved placeholders; each final output keeps its exact rendered
--   content as a confidential attachment with template code, revision, generator and time. Sending is not built.
-- * Restricted HR notes and warnings are a confidential group of their own.

-- ---------------------------------------------------------------------------------------------------------------
-- DB075 lifecycle_process (template), its revisions and ordered template tasks
-- ---------------------------------------------------------------------------------------------------------------
create table lifecycle_process (
  id                     uuid primary key default gen_random_uuid(),
  company_id             uuid not null references company (id) on delete restrict,
  code                   text not null check (code ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  name                   text not null check (btrim(name) <> '' and length(name) <= 200),
  process_type_category  text not null default 'LIFECYCLE_PROCESS_TYPE' check (process_type_category = 'LIFECYCLE_PROCESS_TYPE'),
  process_type_id        uuid not null,
  active                 boolean not null,
  created_at             timestamptz not null default now(),
  created_by             uuid references user_account (id) on delete restrict,
  updated_at             timestamptz not null default now(),
  updated_by             uuid references user_account (id) on delete restrict,
  version                integer not null default 1 check (version > 0),
  unique (company_id, code),
  unique (company_id, id),
  foreign key (company_id, process_type_category, process_type_id) references reference_value (company_id, category, id) on delete restrict
);

create table lifecycle_process_revision (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references company (id) on delete restrict,
  process_id    uuid not null,
  revision      integer not null check (revision > 0),
  state         text not null check (state in ('DRAFT', 'PUBLISHED', 'RETIRED')),
  published_at  timestamptz,
  published_by  uuid references user_account (id) on delete restrict,
  retired_at    timestamptz,
  created_at    timestamptz not null default now(),
  created_by    uuid references user_account (id) on delete restrict,
  updated_at    timestamptz not null default now(),
  updated_by    uuid references user_account (id) on delete restrict,
  version       integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, id, process_id),
  unique (company_id, process_id, revision),
  foreign key (company_id, process_id) references lifecycle_process (company_id, id) on delete restrict,
  check ((state = 'DRAFT') = (published_at is null)),
  check ((published_at is null) = (published_by is null)),
  check ((state = 'RETIRED') = (retired_at is not null))
);
-- One revision being edited and one in force per template.
create unique index lifecycle_process_one_draft on lifecycle_process_revision (company_id, process_id) where (state = 'DRAFT');
create unique index lifecycle_process_one_published on lifecycle_process_revision (company_id, process_id) where (state = 'PUBLISHED');

-- Ordered template tasks. The owner is a role of the company (any holder of that role whose assignment covers the
-- employee and holds the completion duty) or one named user. The due date of an instance task is the process
-- effective date plus the offset in days.
create table lifecycle_process_task (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references company (id) on delete restrict,
  revision_id        uuid not null,
  sequence           integer not null check (sequence between 1 and 200),
  code               text not null check (code ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  title              text not null check (btrim(title) <> '' and length(title) <= 200),
  owner_kind         text not null check (owner_kind in ('ROLE', 'USER')),
  owner_role_code    text,
  owner_user_id      uuid references user_account (id) on delete restrict,
  required           boolean not null,
  due_offset_days    integer not null check (due_offset_days between -3650 and 3650),
  evidence_required  boolean not null,
  created_at         timestamptz not null default now(),
  created_by         uuid references user_account (id) on delete restrict,
  updated_at         timestamptz not null default now(),
  updated_by         uuid references user_account (id) on delete restrict,
  version            integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, revision_id, sequence),
  unique (company_id, revision_id, code),
  foreign key (company_id, revision_id) references lifecycle_process_revision (company_id, id) on delete restrict,
  foreign key (company_id, owner_role_code) references role (company_id, code) on delete restrict,
  check ((owner_kind = 'ROLE') = (owner_role_code is not null)),
  check ((owner_kind = 'USER') = (owner_user_id is not null))
);

-- The template's code and type identify it for its whole life.
create function hrms_lifecycle_process_guard() returns trigger language plpgsql as $$
begin
  if (new.code, new.process_type_id) is distinct from (old.code, old.process_type_id) then
    raise exception 'a process template code and type are immutable' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger lifecycle_process_guard before update on lifecycle_process for each row execute function hrms_lifecycle_process_guard();

-- Revisions are consecutive and start as DRAFT; a published revision is frozen and may only be retired.
create function hrms_lifecycle_process_revision_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.state <> 'DRAFT' then
      raise exception 'a template revision starts as a draft' using errcode = '23514';
    end if;
    if new.revision <> coalesce((select max(revision) from lifecycle_process_revision
                                  where company_id = new.company_id and process_id = new.process_id), 0) + 1 then
      raise exception 'template revisions are consecutive' using errcode = '23514';
    end if;
    return new;
  end if;
  if (new.process_id, new.revision) is distinct from (old.process_id, old.revision) then
    raise exception 'template revision identity is immutable' using errcode = '23514';
  end if;
  if new.state <> old.state and not ((old.state = 'DRAFT' and new.state = 'PUBLISHED') or (old.state = 'PUBLISHED' and new.state = 'RETIRED')) then
    raise exception 'template revision cannot move from % to %', old.state, new.state using errcode = '23514';
  end if;
  if old.state <> 'DRAFT' and (new.published_at, new.published_by) is distinct from (old.published_at, old.published_by) then
    raise exception 'a published template revision is frozen' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger lifecycle_process_revision_guard before insert or update on lifecycle_process_revision
  for each row execute function hrms_lifecycle_process_revision_guard();

-- Template tasks change only while their revision is a draft.
create function hrms_lifecycle_process_task_guard() returns trigger language plpgsql as $$
declare
  rev_state text;
begin
  select state into rev_state from lifecycle_process_revision
   where company_id = coalesce(new.company_id, old.company_id) and id = coalesce(new.revision_id, old.revision_id);
  if rev_state is distinct from 'DRAFT' then
    raise exception 'tasks of a published template revision are frozen' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and new.revision_id <> old.revision_id then
    raise exception 'a template task cannot move to another revision' using errcode = '23514';
  end if;
  return coalesce(new, old);
end $$;
create trigger lifecycle_process_task_guard before insert or update or delete on lifecycle_process_task
  for each row execute function hrms_lifecycle_process_task_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- DB078 exit_case: the employee's resignation (typed root, one open exit per employee)
-- ---------------------------------------------------------------------------------------------------------------
create table exit_case (
  id                        uuid primary key default gen_random_uuid(),
  company_id                uuid not null references company (id) on delete restrict,
  employee_id               uuid not null,
  transaction_kind          text not null default 'exit_case' check (transaction_kind = 'exit_case'),
  transaction_id            uuid not null,
  -- F1 selects the employee-submitted resignation; other separation types need an owner decision first.
  separation_type           text not null check (separation_type = 'RESIGNATION'),
  -- Company-local business date of the resignation.
  request_date              date not null,
  proposed_leaving_date     date not null,
  recommended_leaving_date  date,
  approved_leaving_date     date,
  -- DB078 leaving_date: the case's current last working date (inclusive): proposed, then recommended, then approved.
  leaving_date              date not null,
  -- Private reason (confidential exit `reason` group; the employee's own under H1).
  reason_code_category      text not null default 'EXIT_REASON' check (reason_code_category = 'EXIT_REASON'),
  reason_code_id            uuid,
  reason                    text check (reason is null or (btrim(reason) <> '' and length(reason) <= 1000)),
  -- F1: the contractual notice period is recorded by HR from the contract; there is no default. It is required
  -- before any monetary notice adjustment; nothing computes notice pay.
  contractual_notice_days   integer check (contractual_notice_days between 0 and 3650),
  -- Status before NOTICE, restored if an approved resignation is withdrawn.
  prior_status_code         text check (prior_status_code in ('ACTIVE_PROBATION', 'ACTIVE_CONFIRMED')),
  -- H4-style explanation shown to the employee when HR does not approve; the decision reason stays private.
  employee_message          text check (employee_message is null or (btrim(employee_message) <> '' and length(employee_message) <= 1000)),
  state                     text not null check (state in ('SUBMITTED', 'RECOMMENDED', 'APPROVED', 'SEPARATED', 'REJECTED', 'WITHDRAWN')),
  submitted_at              timestamptz not null default now(),
  recommended_at            timestamptz,
  approved_at               timestamptz,
  separated_at              timestamptz,
  closed_at                 timestamptz,
  -- Final release of the exit (clearance complete): recorded once, never undone.
  released_at               timestamptz,
  released_by               uuid references user_account (id) on delete restrict,
  created_at                timestamptz not null default now(),
  created_by                uuid references user_account (id) on delete restrict,
  updated_at                timestamptz not null default now(),
  updated_by                uuid references user_account (id) on delete restrict,
  version                   integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, id, employee_id),
  unique (company_id, transaction_id),
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict,
  foreign key (company_id, transaction_kind, transaction_id) references business_transaction (company_id, kind, id)
    on delete restrict deferrable initially deferred,
  foreign key (company_id, reason_code_category, reason_code_id) references reference_value (company_id, category, id) on delete restrict,
  check (proposed_leaving_date >= request_date),
  check (recommended_leaving_date is null or recommended_leaving_date >= request_date),
  check (approved_leaving_date is null or approved_leaving_date >= request_date),
  check (leaving_date = coalesce(approved_leaving_date, recommended_leaving_date, proposed_leaving_date)),
  check (state not in ('RECOMMENDED', 'APPROVED', 'SEPARATED') or (recommended_leaving_date is not null and recommended_at is not null)),
  check (state not in ('APPROVED', 'SEPARATED') or (approved_leaving_date is not null and approved_at is not null and prior_status_code is not null)),
  check ((approved_leaving_date is null) = (approved_at is null)),
  check ((state = 'SEPARATED') = (separated_at is not null)),
  check ((state in ('REJECTED', 'WITHDRAWN')) = (closed_at is not null)),
  check ((released_at is null) = (released_by is null)),
  check (released_at is null or state in ('APPROVED', 'SEPARATED'))
);
-- DB078: one effective open exit per employee.
create unique index exit_case_one_open on exit_case (company_id, employee_id) where (state in ('SUBMITTED', 'RECOMMENDED', 'APPROVED'));
create index exit_case_due_idx on exit_case (company_id, approved_leaving_date) where (state = 'APPROVED');

-- The submitted facts never change; each later date is set once by its decision; the release is final.
create function hrms_exit_case_guard() returns trigger language plpgsql as $$
begin
  if (new.employee_id, new.transaction_id, new.separation_type, new.request_date, new.proposed_leaving_date, new.reason_code_id, new.reason, new.submitted_at)
     is distinct from (old.employee_id, old.transaction_id, old.separation_type, old.request_date, old.proposed_leaving_date, old.reason_code_id, old.reason, old.submitted_at) then
    raise exception 'a submitted resignation is immutable' using errcode = '23514';
  end if;
  if old.recommended_leaving_date is not null and new.recommended_leaving_date is distinct from old.recommended_leaving_date then
    raise exception 'the recommended last working date is fixed once recorded' using errcode = '23514';
  end if;
  if old.approved_leaving_date is not null and new.approved_leaving_date is distinct from old.approved_leaving_date then
    raise exception 'the approved last working date is fixed once approved' using errcode = '23514';
  end if;
  if old.prior_status_code is not null and new.prior_status_code is distinct from old.prior_status_code then
    raise exception 'the recorded prior status is fixed' using errcode = '23514';
  end if;
  if old.released_at is not null and (new.released_at, new.released_by, new.contractual_notice_days)
     is distinct from (old.released_at, old.released_by, old.contractual_notice_days) then
    raise exception 'a released exit is final' using errcode = '23514';
  end if;
  if old.employee_message is not null and new.employee_message is distinct from old.employee_message then
    raise exception 'the employee message is fixed once given' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger exit_case_guard before update on exit_case for each row execute function hrms_exit_case_guard();

-- Attributable exit history (DF08; FR-051 "a withdrawal preserves the prior request and decision trail").
create table exit_case_event (
  id                     uuid primary key default gen_random_uuid(),
  company_id             uuid not null references company (id) on delete restrict,
  exit_case_id           uuid not null,
  employee_id            uuid not null,
  action                 text not null check (action in ('SUBMIT', 'RECOMMEND', 'APPROVE', 'REJECT', 'WITHDRAW', 'WITHDRAWAL_REQUESTED',
                                                         'WITHDRAWAL_APPROVED', 'WITHDRAWAL_REJECTED', 'WITHDRAWAL_CANCELLED',
                                                         'NOTICE_PERIOD_RECORDED', 'SEPARATE', 'FINAL_RELEASE')),
  from_state             text not null,
  to_state               text not null,
  leaving_date           date,
  employee_status_before text,
  employee_status_after  text,
  actor_user_id          uuid not null references user_account (id) on delete restrict,
  acting_assignment_id   uuid,
  business_date          date not null,
  occurred_at            timestamptz not null default now(),
  created_at             timestamptz not null default now(),
  created_by             uuid references user_account (id) on delete restrict,
  unique (company_id, id),
  foreign key (company_id, exit_case_id, employee_id) references exit_case (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, acting_assignment_id) references role_assignment (company_id, id) on delete restrict
);
create index exit_case_event_case_idx on exit_case_event (company_id, exit_case_id, occurred_at);
create trigger exit_case_event_append_only before update or delete on exit_case_event for each row execute function hrms_append_only();

-- Withdrawal of an approved resignation: its own request, decided by an independent HR Administrator (F1).
create table exit_withdrawal_request (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references company (id) on delete restrict,
  exit_case_id      uuid not null,
  employee_id       uuid not null,
  transaction_kind  text not null default 'exit_withdrawal' check (transaction_kind = 'exit_withdrawal'),
  transaction_id    uuid not null,
  -- Private reason (exit `reason` group).
  reason            text not null check (btrim(reason) <> '' and length(reason) <= 1000),
  employee_message  text check (employee_message is null or (btrim(employee_message) <> '' and length(employee_message) <= 1000)),
  state             text not null check (state in ('SUBMITTED', 'APPROVED', 'REJECTED', 'WITHDRAWN')),
  decided_at        timestamptz,
  created_at        timestamptz not null default now(),
  created_by        uuid references user_account (id) on delete restrict,
  updated_at        timestamptz not null default now(),
  updated_by        uuid references user_account (id) on delete restrict,
  version           integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, transaction_id),
  foreign key (company_id, exit_case_id, employee_id) references exit_case (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, transaction_kind, transaction_id) references business_transaction (company_id, kind, id)
    on delete restrict deferrable initially deferred,
  check ((state in ('APPROVED', 'REJECTED')) = (decided_at is not null))
);
create unique index exit_withdrawal_one_open on exit_withdrawal_request (company_id, exit_case_id) where (state = 'SUBMITTED');

create function hrms_exit_withdrawal_guard() returns trigger language plpgsql as $$
begin
  if (new.exit_case_id, new.employee_id, new.transaction_id, new.reason) is distinct from (old.exit_case_id, old.employee_id, old.transaction_id, old.reason) then
    raise exception 'a withdrawal request is immutable' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger exit_withdrawal_request_guard before update on exit_withdrawal_request for each row execute function hrms_exit_withdrawal_guard();

-- Approved last working date of an employee's effective exit (inclusive), for attendance, leave and payroll
-- eligibility checks (DF04: eligibility stops after it). NULL when no approved exit is in effect.
create function hrms_exit_last_working_date(p_company_id uuid, p_employee_id uuid) returns date
language sql stable as $$
  select approved_leaving_date from exit_case
   where company_id = p_company_id and employee_id = p_employee_id and state in ('APPROVED', 'SEPARATED')
   order by approved_leaving_date desc limit 1
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- DB076 employee_process (typed root) with per-instance tasks copied from the published template revision
-- ---------------------------------------------------------------------------------------------------------------
create table employee_process (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references company (id) on delete restrict,
  employee_id          uuid not null,
  process_id           uuid not null,
  process_revision_id  uuid not null,
  transaction_kind     text not null default 'employee_process' check (transaction_kind = 'employee_process'),
  transaction_id       uuid not null,
  effective_date       date not null,
  -- The HR owner accountable for the process (DF04 contract "owner").
  owner_user_id        uuid not null references user_account (id) on delete restrict,
  -- Set for an exit clearance checklist (CI14: same employee as the exit).
  exit_case_id         uuid,
  state                text not null check (state in ('OPEN', 'CLOSED', 'CANCELLED')),
  closed_at            timestamptz,
  closed_by            uuid references user_account (id) on delete restrict,
  cancelled_at         timestamptz,
  reopen_count         integer not null default 0 check (reopen_count >= 0),
  created_at           timestamptz not null default now(),
  created_by           uuid references user_account (id) on delete restrict,
  updated_at           timestamptz not null default now(),
  updated_by           uuid references user_account (id) on delete restrict,
  version              integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, id, employee_id),
  unique (company_id, transaction_id),
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict,
  foreign key (company_id, process_revision_id, process_id) references lifecycle_process_revision (company_id, id, process_id) on delete restrict,
  foreign key (company_id, transaction_kind, transaction_id) references business_transaction (company_id, kind, id)
    on delete restrict deferrable initially deferred,
  foreign key (company_id, exit_case_id, employee_id) references exit_case (company_id, id, employee_id) on delete restrict,
  check ((state = 'CLOSED') = (closed_at is not null)),
  check ((closed_at is null) = (closed_by is null)),
  check ((state = 'CANCELLED') = (cancelled_at is not null))
);
create index employee_process_employee_idx on employee_process (company_id, employee_id, created_at desc);
-- One live clearance checklist per exit.
create unique index employee_process_one_clearance on employee_process (company_id, exit_case_id) where (exit_case_id is not null and state <> 'CANCELLED');

create function hrms_employee_process_guard() returns trigger language plpgsql as $$
begin
  if (new.employee_id, new.process_id, new.process_revision_id, new.transaction_id, new.effective_date, new.owner_user_id, new.exit_case_id)
     is distinct from (old.employee_id, old.process_id, old.process_revision_id, old.transaction_id, old.effective_date, old.owner_user_id, old.exit_case_id) then
    raise exception 'an employee process identity is immutable' using errcode = '23514';
  end if;
  if new.reopen_count < old.reopen_count then
    raise exception 'the reopen count never decreases' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger employee_process_guard before update on employee_process for each row execute function hrms_employee_process_guard();

create table employee_process_task (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references company (id) on delete restrict,
  employee_process_id   uuid not null,
  employee_id           uuid not null,
  template_task_id      uuid not null,
  sequence              integer not null check (sequence between 1 and 200),
  code                  text not null check (code ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  title                 text not null check (btrim(title) <> '' and length(title) <= 200),
  owner_role_code       text,
  owner_user_id         uuid references user_account (id) on delete restrict,
  required              boolean not null,
  evidence_required     boolean not null,
  due_date              date not null,
  state                 text not null check (state in ('OPEN', 'COMPLETED', 'SKIPPED')),
  -- Who resolved the task (completed it, or skipped an optional task), in which assignment and on which business date.
  done_at               timestamptz,
  done_on               date,
  done_by               uuid references user_account (id) on delete restrict,
  done_assignment_id    uuid,
  evidence_attachment_id uuid,
  created_at            timestamptz not null default now(),
  created_by            uuid references user_account (id) on delete restrict,
  updated_at            timestamptz not null default now(),
  updated_by            uuid references user_account (id) on delete restrict,
  version               integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, id, employee_process_id),
  unique (company_id, employee_process_id, sequence),
  foreign key (company_id, employee_process_id, employee_id) references employee_process (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, template_task_id) references lifecycle_process_task (company_id, id) on delete restrict,
  foreign key (company_id, owner_role_code) references role (company_id, code) on delete restrict,
  foreign key (company_id, done_assignment_id) references role_assignment (company_id, id) on delete restrict,
  -- CI11: evidence is an attachment of the same employee.
  foreign key (company_id, evidence_attachment_id, employee_id) references attachment (company_id, id, employee_id) on delete restrict,
  check ((owner_role_code is null) <> (owner_user_id is null)),
  check ((state = 'OPEN') = (done_at is null)),
  check ((done_at is null) = (done_by is null) and (done_at is null) = (done_on is null) and (done_at is null) = (done_assignment_id is null)),
  -- F1: required tasks are explicit and can never be skipped.
  check (state <> 'SKIPPED' or not required),
  check (state <> 'COMPLETED' or not evidence_required or evidence_attachment_id is not null),
  check (state = 'COMPLETED' or evidence_attachment_id is null)
);
create index employee_process_task_owner_idx on employee_process_task (company_id, owner_user_id) where (state = 'OPEN');
create index employee_process_task_role_idx on employee_process_task (company_id, owner_role_code) where (state = 'OPEN');

-- Copied task facts never change; owners change only while the task is open; any change needs an open process.
create function hrms_employee_process_task_guard() returns trigger language plpgsql as $$
declare
  process_state text;
begin
  select state into process_state from employee_process where company_id = new.company_id and id = new.employee_process_id;
  if tg_op = 'INSERT' then
    if process_state is distinct from 'OPEN' then
      raise exception 'tasks are added only to an open process' using errcode = '23514';
    end if;
    if new.state <> 'OPEN' then
      raise exception 'a process task starts open' using errcode = '23514';
    end if;
    return new;
  end if;
  if (new.employee_process_id, new.employee_id, new.template_task_id, new.sequence, new.code, new.title, new.required, new.evidence_required, new.due_date)
     is distinct from (old.employee_process_id, old.employee_id, old.template_task_id, old.sequence, old.code, old.title, old.required, old.evidence_required, old.due_date) then
    raise exception 'a process task copied from its template is immutable' using errcode = '23514';
  end if;
  if process_state is distinct from 'OPEN' then
    raise exception 'tasks of a closed or cancelled process are fixed; reopen the process first' using errcode = '23514';
  end if;
  if (new.owner_role_code, new.owner_user_id) is distinct from (old.owner_role_code, old.owner_user_id) and old.state <> 'OPEN' then
    raise exception 'only an open task can be reassigned' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger employee_process_task_guard before insert or update on employee_process_task
  for each row execute function hrms_employee_process_task_guard();

-- Process and task history: completion actor and date, reassignment with the prior owner, skips, reopenings,
-- closing and cancelling. The note (completion remark or reason) is restricted (employee_process `note` group).
create table employee_process_event (
  id                      uuid primary key default gen_random_uuid(),
  company_id              uuid not null references company (id) on delete restrict,
  employee_process_id     uuid not null,
  task_id                 uuid,
  action                  text not null check (action in ('START', 'COMPLETE', 'SKIP', 'REOPEN_TASK', 'REASSIGN', 'CLOSE', 'REOPEN', 'CANCEL')),
  from_state              text,
  to_state                text,
  prior_owner_role_code   text,
  prior_owner_user_id     uuid references user_account (id) on delete restrict,
  new_owner_role_code     text,
  new_owner_user_id       uuid references user_account (id) on delete restrict,
  evidence_attachment_id  uuid,
  note                    text check (note is null or (btrim(note) <> '' and length(note) <= 2000)),
  actor_user_id           uuid not null references user_account (id) on delete restrict,
  acting_assignment_id    uuid,
  business_date           date not null,
  occurred_at             timestamptz not null default now(),
  created_at              timestamptz not null default now(),
  created_by              uuid references user_account (id) on delete restrict,
  unique (company_id, id),
  foreign key (company_id, employee_process_id) references employee_process (company_id, id) on delete restrict,
  foreign key (company_id, task_id, employee_process_id) references employee_process_task (company_id, id, employee_process_id) on delete restrict,
  foreign key (company_id, evidence_attachment_id) references attachment (company_id, id) on delete restrict,
  foreign key (company_id, acting_assignment_id) references role_assignment (company_id, id) on delete restrict,
  check (action in ('START', 'CLOSE', 'REOPEN', 'CANCEL') or task_id is not null)
);
create index employee_process_event_process_idx on employee_process_event (company_id, employee_process_id, occurred_at);
create trigger employee_process_event_append_only before update or delete on employee_process_event for each row execute function hrms_append_only();

-- ---------------------------------------------------------------------------------------------------------------
-- Letters (FR-017, FR-018, FR-055): versioned templates and DB077 letter_output
-- ---------------------------------------------------------------------------------------------------------------
create table letter_template (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references company (id) on delete restrict,
  code                  text not null check (code ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  name                  text not null check (btrim(name) <> '' and length(name) <= 200),
  letter_type_category  text not null default 'LETTER_TYPE' check (letter_type_category = 'LETTER_TYPE'),
  letter_type_id        uuid not null,
  active                boolean not null,
  created_at            timestamptz not null default now(),
  created_by            uuid references user_account (id) on delete restrict,
  updated_at            timestamptz not null default now(),
  updated_by            uuid references user_account (id) on delete restrict,
  version               integer not null default 1 check (version > 0),
  unique (company_id, code),
  unique (company_id, id),
  unique (company_id, id, code),
  foreign key (company_id, letter_type_category, letter_type_id) references reference_value (company_id, category, id) on delete restrict
);

create function hrms_letter_template_guard() returns trigger language plpgsql as $$
begin
  if (new.code, new.letter_type_id) is distinct from (old.code, old.letter_type_id) then
    raise exception 'a letter template code and type are immutable' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger letter_template_guard before update on letter_template for each row execute function hrms_letter_template_guard();

create table letter_template_revision (
  id                     uuid primary key default gen_random_uuid(),
  company_id             uuid not null references company (id) on delete restrict,
  template_id            uuid not null,
  revision               integer not null check (revision > 0),
  state                  text not null check (state in ('DRAFT', 'PUBLISHED', 'RETIRED')),
  body                   text not null check (btrim(body) <> '' and length(body) <= 20000),
  -- Approved placeholders the body uses; every one is mandatory unless listed as optional.
  placeholders           text[] not null,
  optional_placeholders  text[] not null default '{}',
  published_at           timestamptz,
  published_by           uuid references user_account (id) on delete restrict,
  retired_at             timestamptz,
  created_at             timestamptz not null default now(),
  created_by             uuid references user_account (id) on delete restrict,
  updated_at             timestamptz not null default now(),
  updated_by             uuid references user_account (id) on delete restrict,
  version                integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, id, template_id, revision),
  unique (company_id, template_id, revision),
  foreign key (company_id, template_id) references letter_template (company_id, id) on delete restrict,
  check (optional_placeholders <@ placeholders),
  check ((state = 'DRAFT') = (published_at is null)),
  check ((published_at is null) = (published_by is null)),
  check ((state = 'RETIRED') = (retired_at is not null))
);
create unique index letter_template_one_draft on letter_template_revision (company_id, template_id) where (state = 'DRAFT');
create unique index letter_template_one_published on letter_template_revision (company_id, template_id) where (state = 'PUBLISHED');

create function hrms_letter_template_revision_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.state <> 'DRAFT' then
      raise exception 'a letter template revision starts as a draft' using errcode = '23514';
    end if;
    if new.revision <> coalesce((select max(revision) from letter_template_revision
                                  where company_id = new.company_id and template_id = new.template_id), 0) + 1 then
      raise exception 'letter template revisions are consecutive' using errcode = '23514';
    end if;
    return new;
  end if;
  if (new.template_id, new.revision) is distinct from (old.template_id, old.revision) then
    raise exception 'letter template revision identity is immutable' using errcode = '23514';
  end if;
  if new.state <> old.state and not ((old.state = 'DRAFT' and new.state = 'PUBLISHED') or (old.state = 'PUBLISHED' and new.state = 'RETIRED')) then
    raise exception 'letter template revision cannot move from % to %', old.state, new.state using errcode = '23514';
  end if;
  if old.state <> 'DRAFT' and (new.body, new.placeholders, new.optional_placeholders, new.published_at, new.published_by)
     is distinct from (old.body, old.placeholders, old.optional_placeholders, old.published_at, old.published_by) then
    raise exception 'a published letter template revision is frozen' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger letter_template_revision_guard before insert or update on letter_template_revision
  for each row execute function hrms_letter_template_revision_guard();

-- DB077 letter_output: the exact rendered output (a confidential attachment), template code and revision, the
-- generating user and time. Append-only; a regeneration is a new output with the next number.
create table letter_output (
  id                       uuid primary key default gen_random_uuid(),
  company_id               uuid not null references company (id) on delete restrict,
  employee_id              uuid not null,
  employee_process_id      uuid not null,
  template_id              uuid not null,
  template_revision_id     uuid not null,
  template_code            text not null,
  template_revision        integer not null check (template_revision > 0),
  output_number            integer not null check (output_number > 0),
  attachment_id            uuid not null,
  checksum                 text not null check (checksum ~ '^[0-9a-f]{64}$'),
  generated_at             timestamptz not null default now(),
  generated_by             uuid not null references user_account (id) on delete restrict,
  generated_assignment_id  uuid not null,
  -- FR-018: sending is a separate explicit action with recipient review; it is not built, so nothing is sent.
  delivery_state           text not null default 'NOT_SENT' check (delivery_state = 'NOT_SENT'),
  -- Optional client key: a retried generation returns the output it already stored instead of a second one.
  idempotency_key          text check (idempotency_key is null or idempotency_key ~ '^[A-Za-z0-9._:-]{8,100}$'),
  created_at               timestamptz not null default now(),
  created_by               uuid references user_account (id) on delete restrict,
  unique (company_id, id),
  unique (company_id, employee_process_id, template_id, output_number),
  foreign key (company_id, employee_process_id, employee_id) references employee_process (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, template_id, template_code) references letter_template (company_id, id, code) on delete restrict,
  foreign key (company_id, template_revision_id, template_id, template_revision)
    references letter_template_revision (company_id, id, template_id, revision) on delete restrict,
  foreign key (company_id, attachment_id, employee_id) references attachment (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, generated_assignment_id) references role_assignment (company_id, id) on delete restrict
);
create index letter_output_employee_idx on letter_output (company_id, employee_id, generated_at desc);
create unique index letter_output_idempotency on letter_output (company_id, idempotency_key) where (idempotency_key is not null);
create trigger letter_output_append_only before update or delete on letter_output for each row execute function hrms_append_only();

-- ---------------------------------------------------------------------------------------------------------------
-- Restricted HR notes, remarks and warnings (FR-018 "restrict notes and warnings to authorised HR roles")
-- ---------------------------------------------------------------------------------------------------------------
create table employee_note (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references company (id) on delete restrict,
  employee_id          uuid not null,
  note_kind            text not null check (note_kind in ('NOTE', 'REMARK', 'WARNING')),
  body                 text not null check (btrim(body) <> '' and length(body) <= 4000),
  exit_case_id         uuid,
  employee_process_id  uuid,
  -- A correction is a new note that supersedes the earlier one (DF08); nothing is edited in place.
  supersedes_note_id   uuid,
  created_at           timestamptz not null default now(),
  created_by           uuid not null references user_account (id) on delete restrict,
  acting_assignment_id uuid not null,
  unique (company_id, id),
  unique (company_id, id, employee_id),
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict,
  foreign key (company_id, exit_case_id, employee_id) references exit_case (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, employee_process_id, employee_id) references employee_process (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, supersedes_note_id, employee_id) references employee_note (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, acting_assignment_id) references role_assignment (company_id, id) on delete restrict
);
create index employee_note_employee_idx on employee_note (company_id, employee_id, created_at desc);
create unique index employee_note_one_successor on employee_note (company_id, supersedes_note_id) where (supersedes_note_id is not null);
create trigger employee_note_append_only before update or delete on employee_note for each row execute function hrms_append_only();

-- ---------------------------------------------------------------------------------------------------------------
-- CI12 mirrors (checked at commit against the row as it is then), versions and no deletes
-- ---------------------------------------------------------------------------------------------------------------
create function hrms_lifecycle_mirror() returns trigger language plpgsql as $$
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

do $$
declare
  t text;
begin
  foreach t in array array['exit_case', 'exit_withdrawal_request', 'employee_process'] loop
    execute format('create constraint trigger %I after insert or update on %I deferrable initially deferred for each row execute function hrms_lifecycle_mirror()',
                   t || '_mirrors_transaction', t);
  end loop;
  foreach t in array array['lifecycle_process', 'lifecycle_process_revision', 'lifecycle_process_task', 'exit_case', 'exit_withdrawal_request',
                           'employee_process', 'employee_process_task', 'letter_template', 'letter_template_revision'] loop
    execute format('create trigger %I before update on %I for each row execute function hrms_touch()', t || '_touch', t);
  end loop;
  -- Template tasks of a draft revision may be replaced while the draft is edited (their guard refuses it afterwards).
  foreach t in array array['lifecycle_process', 'lifecycle_process_revision', 'exit_case', 'exit_withdrawal_request', 'employee_process',
                           'employee_process_task', 'letter_template', 'letter_template_revision'] loop
    execute format('create trigger %I before delete on %I for each row execute function hrms_no_delete()', t || '_no_delete', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Transaction kinds and their state catalogues (DF03; CI15)
-- ---------------------------------------------------------------------------------------------------------------
-- Withdrawal requests use the exit list of HR reviewers.
insert into transaction_kind (kind, root_table, routing_kind) values
  ('employee_process', 'employee_process', null),
  ('exit_case', 'exit_case', null);
insert into transaction_kind (kind, root_table, routing_kind) values ('exit_withdrawal', 'exit_withdrawal_request', 'exit_case');

insert into transaction_state (kind, state, initial, terminal) values
  -- A closed process can be reopened with a reason and the reopen duty (FR-016).
  ('employee_process', 'OPEN',      true,  false),
  ('employee_process', 'CLOSED',    false, false),
  ('employee_process', 'CANCELLED', false, true),
  ('exit_case', 'SUBMITTED',   true,  false),
  ('exit_case', 'RECOMMENDED', false, false),
  ('exit_case', 'APPROVED',    false, false),
  ('exit_case', 'SEPARATED',   false, true),
  ('exit_case', 'REJECTED',    false, true),
  ('exit_case', 'WITHDRAWN',   false, true),
  ('exit_withdrawal', 'SUBMITTED', true,  false),
  ('exit_withdrawal', 'APPROVED',  false, true),
  ('exit_withdrawal', 'REJECTED',  false, true),
  ('exit_withdrawal', 'WITHDRAWN', false, true);
insert into transaction_transition (kind, from_state, to_state) values
  ('employee_process', 'OPEN',   'CLOSED'),
  ('employee_process', 'CLOSED', 'OPEN'),
  ('employee_process', 'OPEN',   'CANCELLED'),
  ('exit_case', 'SUBMITTED',   'RECOMMENDED'),
  ('exit_case', 'SUBMITTED',   'WITHDRAWN'),
  ('exit_case', 'RECOMMENDED', 'APPROVED'),
  ('exit_case', 'RECOMMENDED', 'REJECTED'),
  ('exit_case', 'RECOMMENDED', 'WITHDRAWN'),
  ('exit_case', 'APPROVED',    'SEPARATED'),
  ('exit_case', 'APPROVED',    'WITHDRAWN'),
  ('exit_withdrawal', 'SUBMITTED', 'APPROVED'),
  ('exit_withdrawal', 'SUBMITTED', 'REJECTED'),
  ('exit_withdrawal', 'SUBMITTED', 'WITHDRAWN');

-- ---------------------------------------------------------------------------------------------------------------
-- Permission catalogue. Operational groups are declared by the module registration (DB106 rows); everything else
-- is confidential: process remarks and evidence, restricted notes, letters and the exit reason. The employee's own
-- resignation reason is the only own-ESS group (H1/BR-053: own submissions).
-- ---------------------------------------------------------------------------------------------------------------
insert into permission (resource, action, field_group, own_ess) values
  ('lifecycle_process', 'read',          'operational', false),
  ('lifecycle_process', 'manage',        'operational', false),
  ('employee_process',  'read',          'operational', false),
  ('employee_process',  'manage',        'operational', false),
  ('employee_process',  'complete_task', 'operational', false),
  ('employee_process',  'reopen',        'operational', false),
  ('employee_process',  'read',          'note',        false),
  ('employee_process',  'read_evidence', 'evidence',    false),
  ('employee_note',     'read',          'restricted',  false),
  ('employee_note',     'write',         'restricted',  false),
  ('letter_template',   'read',          'operational', false),
  ('letter_template',   'manage',        'operational', false),
  ('letter',            'generate',      'letter',      false),
  ('letter',            'read',          'letter',      false),
  ('exit',              'submit',        'operational', false),
  ('exit',              'read',          'operational', false),
  ('exit',              'read',          'reason',      true),
  ('exit',              'recommend',     'operational', false),
  ('exit',              'approve',       'operational', false),
  ('exit',              'manage',        'operational', false);
