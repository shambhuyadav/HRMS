-- 0002 Platform: typed transactions, workflow and approvals, attachments, audit, outbox, imports, reports.
-- BRD v8.1: DB012, DB040-DB046, DB081, DB082, DB084, DB085; CI01, CI02, CI10, CI11, CI12, CI15, CI16; C4/C5.
-- Proposed target schema; not an extracted source schema.

-- ---------------------------------------------------------------------------
-- Typed transaction registry (B5 / CI12). Each module migration registers its kind, its root
-- table and its state/transition catalogue when it creates the root table. A business_transaction
-- of an unregistered kind cannot exist.
-- ---------------------------------------------------------------------------
create table transaction_kind (
  kind        text primary key check (kind ~ '^[a-z][a-z0-9_]{0,59}$'),
  root_table  text not null unique check (root_table ~ '^[a-z][a-z0-9_]{0,62}$'),
  created_at  timestamptz not null default now()
);

create table transaction_state (
  kind      text not null references transaction_kind (kind) on delete restrict,
  state     text not null check (state ~ '^[A-Z][A-Z0-9_]{0,59}$'),
  initial   boolean not null,
  terminal  boolean not null,
  primary key (kind, state),
  check (not (initial and terminal))
);

create table transaction_transition (
  kind        text not null,
  from_state  text not null,
  to_state    text not null,
  primary key (kind, from_state, to_state),
  check (from_state <> to_state),
  foreign key (kind, from_state) references transaction_state (kind, state) on delete restrict,
  foreign key (kind, to_state)   references transaction_state (kind, state) on delete restrict
);

-- DB040 business_transaction
create table business_transaction (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references company (id) on delete restrict,
  kind               text not null references transaction_kind (kind) on delete restrict,
  owner_employee_id  uuid,
  revision           integer not null default 1 check (revision > 0),
  state              text not null,
  created_at         timestamptz not null default now(),
  created_by         uuid references user_account (id) on delete restrict,
  updated_at         timestamptz not null default now(),
  updated_by         uuid references user_account (id) on delete restrict,
  version            integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, kind, id),
  foreign key (company_id, owner_employee_id) references employee (company_id, id) on delete restrict,
  foreign key (kind, state) references transaction_state (kind, state) on delete restrict
);
create index business_transaction_owner_idx on business_transaction (company_id, owner_employee_id, kind);

-- Initial state on insert; catalogued transitions only; kind/owner fixed; revision never decreases;
-- terminal states are final.
create function hrms_transaction_state_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if not exists (select 1 from transaction_state where kind = new.kind and state = new.state and initial) then
      raise exception 'state % is not an initial state of %', new.state, new.kind using errcode = '23514';
    end if;
    return new;
  end if;
  if new.kind <> old.kind or new.owner_employee_id is distinct from old.owner_employee_id then
    raise exception 'transaction kind and owner are immutable' using errcode = '23514';
  end if;
  if new.revision < old.revision then
    raise exception 'transaction revision cannot decrease' using errcode = '23514';
  end if;
  if new.state <> old.state and not exists (
    select 1 from transaction_transition where kind = new.kind and from_state = old.state and to_state = new.state
  ) then
    raise exception 'transition % -> % is not allowed for %', old.state, new.state, new.kind using errcode = '23514';
  end if;
  return new;
end $$;

create trigger business_transaction_state_guard
  before insert or update on business_transaction
  for each row execute function hrms_transaction_state_guard();

-- CI12: exactly one typed root must exist (checked at commit). Root tables carry a UNIQUE
-- transaction_id plus a composite FK (company_id, transaction_kind, transaction_id), so "at most one"
-- and "matching kind" are enforced by keys; this trigger supplies "at least one".
create function hrms_transaction_root_check() returns trigger language plpgsql as $$
declare
  root regclass;
  found boolean;
begin
  select to_regclass(root_table) into root from transaction_kind where kind = new.kind;
  if root is null then
    raise exception 'root table for kind % does not exist', new.kind using errcode = '23514';
  end if;
  execute format('select exists (select 1 from %s where company_id = $1 and transaction_id = $2)', root)
    into found using new.company_id, new.id;
  if not found then
    raise exception 'business_transaction % has no % root', new.id, new.kind using errcode = '23514';
  end if;
  return null;
end $$;

create constraint trigger business_transaction_has_root
  after insert on business_transaction
  deferrable initially deferred
  for each row execute function hrms_transaction_root_check();

-- ---------------------------------------------------------------------------
-- DB041 workflow_definition / DB042 workflow_step
-- ---------------------------------------------------------------------------
create table workflow_definition (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references company (id) on delete restrict,
  kind            text not null references transaction_kind (kind) on delete restrict,
  revision        integer not null check (revision > 0),
  effective_from  timestamptz not null,
  effective_to    timestamptz check (effective_to > effective_from),
  active          boolean not null,
  created_at      timestamptz not null default now(),
  created_by      uuid references user_account (id) on delete restrict,
  updated_at      timestamptz not null default now(),
  updated_by      uuid references user_account (id) on delete restrict,
  version         integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, kind, id),
  unique (company_id, kind, revision),
  exclude using gist (company_id with =, kind with =, tstzrange(effective_from, effective_to, '[)') with &&)
    where (active)
);

create table workflow_step (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references company (id) on delete restrict,
  workflow_id      uuid not null,
  sequence         integer not null check (sequence > 0),
  permission_id    uuid not null references permission (id) on delete restrict,
  -- DF03 reviewer selection; quorum is one eligible decision per step (no implicit parallel quorum).
  selection_rule   text not null check (selection_rule in ('DIRECT_MANAGER', 'HR_FALLBACK_LIST', 'PERMISSION_IN_SCOPE')),
  completion_rule  text not null check (completion_rule in ('ANY_ONE_ELIGIBLE')),
  created_at       timestamptz not null default now(),
  created_by       uuid references user_account (id) on delete restrict,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references user_account (id) on delete restrict,
  version          integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, workflow_id, id),
  unique (company_id, workflow_id, sequence),
  foreign key (company_id, workflow_id) references workflow_definition (company_id, id) on delete restrict
);

-- ---------------------------------------------------------------------------
-- DB043 approval_instance. Kind is carried so that transaction and workflow kinds must agree by FK,
-- and workflow_id is carried into tasks so that a task step must belong to the instance's
-- workflow by FK (CI01).
-- ---------------------------------------------------------------------------
create table approval_instance (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references company (id) on delete restrict,
  transaction_kind      text not null,
  transaction_id        uuid not null,
  transaction_revision  integer not null check (transaction_revision > 0),
  workflow_id           uuid not null,
  state                 text not null check (state in ('ACTIVE', 'APPROVED', 'REJECTED', 'RETURNED', 'SUPERSEDED', 'CANCELLED')),
  created_at            timestamptz not null default now(),
  created_by            uuid references user_account (id) on delete restrict,
  updated_at            timestamptz not null default now(),
  updated_by            uuid references user_account (id) on delete restrict,
  version               integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, workflow_id, id),
  unique (company_id, transaction_id, transaction_revision),
  foreign key (company_id, transaction_kind, transaction_id)
    references business_transaction (company_id, kind, id) on delete restrict,
  foreign key (company_id, transaction_kind, workflow_id)
    references workflow_definition (company_id, kind, id) on delete restrict
);
create unique index approval_instance_one_active
  on approval_instance (company_id, transaction_id) where (state = 'ACTIVE');

-- CI02: an instance pins the transaction's current submitted revision; states only leave ACTIVE.
create function hrms_approval_instance_guard() returns trigger language plpgsql as $$
declare
  current_revision integer;
begin
  if tg_op = 'INSERT' then
    select revision into current_revision from business_transaction
     where company_id = new.company_id and id = new.transaction_id;
    if new.transaction_revision <> current_revision then
      raise exception 'approval instance must pin current transaction revision %', current_revision
        using errcode = '23514';
    end if;
    if new.state <> 'ACTIVE' then
      raise exception 'approval instance must start ACTIVE' using errcode = '23514';
    end if;
    return new;
  end if;
  if (new.transaction_id, new.transaction_revision, new.workflow_id) is distinct from
     (old.transaction_id, old.transaction_revision, old.workflow_id) then
    raise exception 'approval instance identity is immutable' using errcode = '23514';
  end if;
  if new.state <> old.state and old.state <> 'ACTIVE' then
    raise exception 'approval instance in % is final', old.state using errcode = '23514';
  end if;
  return new;
end $$;

create trigger approval_instance_guard
  before insert or update on approval_instance
  for each row execute function hrms_approval_instance_guard();

-- Workflow definitions are immutable once an instance uses them; only active/effective_to may
-- still change on the definition (to retire it).
create function hrms_workflow_definition_immutable() returns trigger language plpgsql as $$
begin
  if exists (select 1 from approval_instance where company_id = old.company_id and workflow_id = old.id) then
    if tg_op = 'UPDATE'
       and (new.kind, new.revision, new.effective_from) is not distinct from (old.kind, old.revision, old.effective_from) then
      return new;
    end if;
    raise exception 'workflow definition % is in use and immutable', old.id using errcode = '23514';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;

create function hrms_workflow_step_immutable() returns trigger language plpgsql as $$
begin
  if exists (select 1 from approval_instance where company_id = old.company_id and workflow_id = old.workflow_id) then
    raise exception 'workflow definition % is in use and immutable', old.workflow_id using errcode = '23514';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;

create trigger workflow_definition_immutable
  before update or delete on workflow_definition
  for each row execute function hrms_workflow_definition_immutable();
create trigger workflow_step_immutable
  before update or delete on workflow_step
  for each row execute function hrms_workflow_step_immutable();

-- ---------------------------------------------------------------------------
-- DB044 approval_task. Delegated tasks: assignee must be the delegation's delegate (CI10).
-- ---------------------------------------------------------------------------
alter table delegation add constraint delegation_delegate_uq unique (company_id, id, delegate_user_id);

create table approval_task (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references company (id) on delete restrict,
  instance_id       uuid not null,
  workflow_id       uuid not null,
  step_id           uuid not null,
  assignee_user_id  uuid not null references user_account (id) on delete restrict,
  delegation_id     uuid,
  state             text not null check (state in ('PENDING', 'APPROVED', 'REJECTED', 'RETURNED', 'SUPERSEDED', 'CANCELLED')),
  due_at            timestamptz,
  decided_at        timestamptz,
  created_at        timestamptz not null default now(),
  created_by        uuid references user_account (id) on delete restrict,
  updated_at        timestamptz not null default now(),
  updated_by        uuid references user_account (id) on delete restrict,
  version           integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, id, assignee_user_id),
  unique (company_id, instance_id, step_id, assignee_user_id),
  foreign key (company_id, workflow_id, instance_id) references approval_instance (company_id, workflow_id, id) on delete restrict,
  foreign key (company_id, workflow_id, step_id)     references workflow_step (company_id, workflow_id, id)     on delete restrict,
  foreign key (company_id, delegation_id, assignee_user_id)
    references delegation (company_id, id, delegate_user_id) on delete restrict,
  check ((state in ('PENDING', 'SUPERSEDED', 'CANCELLED')) or decided_at is not null),
  check (state <> 'PENDING' or decided_at is null)
);
create index approval_task_assignee_idx on approval_task (company_id, assignee_user_id, state);

create function hrms_approval_task_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.state <> 'PENDING' then
      raise exception 'approval task must start PENDING' using errcode = '23514';
    end if;
    return new;
  end if;
  if (new.instance_id, new.step_id, new.assignee_user_id, new.delegation_id) is distinct from
     (old.instance_id, old.step_id, old.assignee_user_id, old.delegation_id) then
    raise exception 'approval task identity is immutable' using errcode = '23514';
  end if;
  if new.state <> old.state and old.state <> 'PENDING' then
    raise exception 'approval task in % is final', old.state using errcode = '23514';
  end if;
  return new;
end $$;

create trigger approval_task_guard
  before insert or update on approval_task
  for each row execute function hrms_approval_task_guard();

-- ---------------------------------------------------------------------------
-- DB045 approval_decision: append-only, one per task, actor is the assignee.
-- ---------------------------------------------------------------------------
create table approval_decision (
  id                     uuid primary key default gen_random_uuid(),
  company_id             uuid not null references company (id) on delete restrict,
  task_id                uuid not null,
  actor_user_id          uuid not null references user_account (id) on delete restrict,
  acting_assignment_id   uuid not null,
  decision               text not null check (decision in ('APPROVE', 'REJECT', 'RETURN')),
  reason                 text,
  occurred_at            timestamptz not null default now(),
  expected_version       integer not null check (expected_version > 0),
  idempotency_key        text not null check (length(idempotency_key) between 8 and 200),
  created_at             timestamptz not null default now(),
  created_by             uuid references user_account (id) on delete restrict,
  updated_at             timestamptz not null default now(),
  updated_by             uuid references user_account (id) on delete restrict,
  version                integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, task_id),
  unique (company_id, idempotency_key),
  foreign key (company_id, task_id, actor_user_id) references approval_task (company_id, id, assignee_user_id) on delete restrict,
  foreign key (company_id, acting_assignment_id) references role_assignment (company_id, id) on delete restrict,
  check (decision = 'APPROVE' or (reason is not null and btrim(reason) <> ''))
);

-- C4 at the data layer: the task must be pending in an active instance pinned to the current
-- revision; the actor must hold the acting assignment and must never be linked to the
-- transaction owner employee (any period, so former self-links still count); a delegated task
-- needs a live delegation whose delegator is not the owner either.
create function hrms_approval_decision_guard() returns trigger language plpgsql as $$
declare
  t approval_task%rowtype;
  i approval_instance%rowtype;
  bt business_transaction%rowtype;
  asg role_assignment%rowtype;
  d delegation%rowtype;
begin
  select * into t from approval_task where company_id = new.company_id and id = new.task_id for update;
  select * into i from approval_instance where company_id = new.company_id and id = t.instance_id;
  select * into bt from business_transaction where company_id = new.company_id and id = i.transaction_id;
  select * into asg from role_assignment where company_id = new.company_id and id = new.acting_assignment_id;

  if t.state <> 'PENDING' or i.state <> 'ACTIVE' then
    raise exception 'task is not open for decision' using errcode = '23514';
  end if;
  if i.transaction_revision <> bt.revision then
    raise exception 'decision targets a superseded revision' using errcode = '23514';
  end if;
  if new.expected_version <> bt.version then
    raise exception 'stale transaction version' using errcode = '40001';
  end if;
  if asg.user_id <> new.actor_user_id or asg.state <> 'ACTIVE'
     or new.occurred_at < asg.effective_from or (asg.effective_to is not null and new.occurred_at >= asg.effective_to) then
    raise exception 'acting assignment is not active for this actor' using errcode = '23514';
  end if;
  if bt.owner_employee_id is not null and exists (
    select 1 from user_employee_link l
     where l.company_id = new.company_id and l.user_id = new.actor_user_id and l.employee_id = bt.owner_employee_id
  ) then
    raise exception 'self decision is prohibited' using errcode = '23514';
  end if;
  if t.delegation_id is not null then
    select * into d from delegation where company_id = new.company_id and id = t.delegation_id;
    if new.occurred_at < d.effective_from or new.occurred_at >= d.effective_to then
      raise exception 'delegation is not effective' using errcode = '23514';
    end if;
    if bt.owner_employee_id is not null and exists (
      select 1 from user_employee_link l
       where l.company_id = new.company_id and l.user_id = d.delegator_user_id and l.employee_id = bt.owner_employee_id
    ) then
      raise exception 'delegated self decision is prohibited' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

create trigger approval_decision_guard
  before insert on approval_decision
  for each row execute function hrms_approval_decision_guard();

create function hrms_append_only() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = '23514';
end $$;

create trigger approval_decision_append_only
  before update or delete on approval_decision
  for each row execute function hrms_append_only();

-- ---------------------------------------------------------------------------
-- DB046 attachment and DB012 employee_document (CI11)
-- ---------------------------------------------------------------------------
create table attachment (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references company (id) on delete restrict,
  owner_user_id      uuid not null references user_account (id) on delete restrict,
  employee_id        uuid,
  content_reference  text not null check (btrim(content_reference) <> ''),
  media_type         text not null check (media_type ~ '^[a-z]+/[a-z0-9.+-]+$'),
  checksum           text not null check (checksum ~ '^[0-9a-f]{64}$'),
  classification     text not null default 'CONFIDENTIAL' check (classification in ('CONFIDENTIAL', 'OPERATIONAL')),
  created_at         timestamptz not null default now(),
  created_by         uuid references user_account (id) on delete restrict,
  updated_at         timestamptz not null default now(),
  updated_by         uuid references user_account (id) on delete restrict,
  version            integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, id, employee_id),
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict
);

create table employee_document (
  id                         uuid primary key default gen_random_uuid(),
  company_id                 uuid not null references company (id) on delete restrict,
  employee_id                uuid not null,
  document_type_category     text not null default 'DOCUMENT_TYPE' check (document_type_category = 'DOCUMENT_TYPE'),
  document_type_id           uuid not null,
  attachment_id              uuid not null,
  expires_on                 date,
  created_at                 timestamptz not null default now(),
  created_by                 uuid references user_account (id) on delete restrict,
  updated_at                 timestamptz not null default now(),
  updated_by                 uuid references user_account (id) on delete restrict,
  version                    integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, attachment_id),
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict,
  foreign key (company_id, document_type_category, document_type_id)
    references reference_value (company_id, category, id) on delete restrict,
  foreign key (company_id, attachment_id, employee_id)
    references attachment (company_id, id, employee_id) on delete restrict
);

-- ---------------------------------------------------------------------------
-- DB082 audit_event: append-only; create has after, delete has before, update has both.
-- ---------------------------------------------------------------------------
create table audit_event (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references company (id) on delete restrict,
  resource_code         text not null check (resource_code ~ '^[a-z][a-z0-9_]{0,59}$'),
  record_key            uuid not null,
  actor_user_id         uuid not null references user_account (id) on delete restrict,
  acting_assignment_id  uuid,
  action                text not null check (action ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  occurred_at           timestamptz not null default now(),
  prior_version         integer check (prior_version > 0),
  new_version           integer check (new_version > 0),
  before_values         jsonb,
  after_values          jsonb,
  reason                text,
  created_at            timestamptz not null default now(),
  created_by            uuid references user_account (id) on delete restrict,
  updated_at            timestamptz not null default now(),
  updated_by            uuid references user_account (id) on delete restrict,
  version               integer not null default 1 check (version > 0),
  unique (company_id, id),
  foreign key (company_id, acting_assignment_id) references role_assignment (company_id, id) on delete restrict,
  check (action <> 'CREATE' or after_values is not null),
  check (action <> 'DELETE' or before_values is not null),
  check (action <> 'UPDATE' or (before_values is not null and after_values is not null)),
  check (new_version is null or prior_version is null or new_version > prior_version)
);
create index audit_event_record_idx on audit_event (company_id, resource_code, record_key, occurred_at);

create trigger audit_event_append_only
  before update or delete on audit_event
  for each row execute function hrms_append_only();

-- ---------------------------------------------------------------------------
-- Technical table (not one of the 109 business tables): transactional outbox.
-- Written in the same transaction as the business change; published after commit (BR-033, ZT18).
-- Payloads carry identifiers only, never confidential values.
-- ---------------------------------------------------------------------------
create table outbox_event (
  id            bigint generated always as identity primary key,
  company_id    uuid not null references company (id) on delete restrict,
  topic         text not null check (topic ~ '^[a-z][a-z0-9_.]{0,99}$'),
  aggregate_id  uuid not null,
  dedupe_key    text not null,
  payload       jsonb not null,
  created_at    timestamptz not null default now(),
  published_at  timestamptz,
  attempts      integer not null default 0 check (attempts >= 0),
  unique (company_id, dedupe_key)
);
create index outbox_event_unpublished_idx on outbox_event (id) where (published_at is null);

-- ---------------------------------------------------------------------------
-- DB084 import_job / DB085 import_row (CI16: terminal counts reconcile to rows)
-- ---------------------------------------------------------------------------
create table import_job (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references company (id) on delete restrict,
  kind             text not null check (kind ~ '^[a-z][a-z0-9_]{0,59}$'),
  state            text not null check (state in ('UPLOADED', 'VALIDATED', 'PREVIEWED', 'COMMITTING', 'COMMITTED', 'REJECTED', 'CANCELLED')),
  attachment_id    uuid not null,
  submitted_by     uuid not null references user_account (id) on delete restrict,
  idempotency_key  text not null check (length(idempotency_key) between 8 and 200),
  accepted_count   integer not null default 0 check (accepted_count >= 0),
  rejected_count   integer not null default 0 check (rejected_count >= 0),
  created_at       timestamptz not null default now(),
  created_by       uuid references user_account (id) on delete restrict,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references user_account (id) on delete restrict,
  version          integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, idempotency_key),
  foreign key (company_id, attachment_id) references attachment (company_id, id) on delete restrict
);

create table import_row (
  id                      uuid primary key default gen_random_uuid(),
  company_id              uuid not null references company (id) on delete restrict,
  job_id                  uuid not null,
  row_number              integer not null check (row_number > 0),
  state                   text not null check (state in ('PENDING', 'VALID', 'ACCEPTED', 'REJECTED', 'QUARANTINED')),
  error_code              text check (error_code ~ '^[A-Z][A-Z0-9_]{0,59}$'),
  business_key            text not null,
  applied_transaction_id  uuid,
  created_at              timestamptz not null default now(),
  created_by              uuid references user_account (id) on delete restrict,
  updated_at              timestamptz not null default now(),
  updated_by              uuid references user_account (id) on delete restrict,
  version                 integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, job_id, row_number),
  foreign key (company_id, job_id) references import_job (company_id, id) on delete restrict,
  foreign key (company_id, applied_transaction_id) references business_transaction (company_id, id) on delete restrict,
  check (state not in ('REJECTED', 'QUARANTINED') or error_code is not null)
);

create function hrms_import_job_reconcile() returns trigger language plpgsql as $$
declare
  accepted integer;
  rejected integer;
  open_rows integer;
begin
  if new.state in ('COMMITTED', 'REJECTED') and new.state is distinct from old.state then
    select count(*) filter (where state = 'ACCEPTED'),
           count(*) filter (where state in ('REJECTED', 'QUARANTINED')),
           count(*) filter (where state in ('PENDING', 'VALID'))
      into accepted, rejected, open_rows
      from import_row where company_id = new.company_id and job_id = new.id;
    if open_rows > 0 or accepted <> new.accepted_count or rejected <> new.rejected_count then
      raise exception 'import job counts do not reconcile with its rows' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

create trigger import_job_reconcile
  before update on import_job
  for each row execute function hrms_import_job_reconcile();

-- ---------------------------------------------------------------------------
-- DB081 report_execution (download rechecks permission at request time; no shared cached output)
-- ---------------------------------------------------------------------------
create table report_execution (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references company (id) on delete restrict,
  report_code           text not null check (report_code ~ '^[a-z][a-z0-9_]{0,59}$'),
  requested_by          uuid not null references user_account (id) on delete restrict,
  acting_assignment_id  uuid not null,
  filter_snapshot       jsonb not null,
  scope_snapshot        jsonb not null,
  state                 text not null check (state in ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'EXPIRED')),
  generated_at          timestamptz,
  expires_at            timestamptz,
  output_attachment_id  uuid,
  created_at            timestamptz not null default now(),
  created_by            uuid references user_account (id) on delete restrict,
  updated_at            timestamptz not null default now(),
  updated_by            uuid references user_account (id) on delete restrict,
  version               integer not null default 1 check (version > 0),
  unique (company_id, id),
  foreign key (company_id, acting_assignment_id) references role_assignment (company_id, id) on delete restrict,
  foreign key (company_id, output_attachment_id) references attachment (company_id, id) on delete restrict,
  check (state <> 'COMPLETED' or (generated_at is not null and output_attachment_id is not null))
);

-- ---------------------------------------------------------------------------
-- Generic trigger wiring
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'business_transaction', 'workflow_definition', 'workflow_step', 'approval_instance', 'approval_task',
    'attachment', 'employee_document', 'import_job', 'import_row', 'report_execution'
  ] loop
    execute format('create trigger %I before update on %I for each row execute function hrms_touch()',
                   t || '_touch', t);
  end loop;

  foreach t in array array['business_transaction', 'approval_instance', 'approval_task', 'employee_document', 'import_job', 'import_row'] loop
    execute format('create trigger %I before delete on %I for each row execute function hrms_no_delete()',
                   t || '_no_delete', t);
  end loop;
end $$;
