-- 0018 Leave resubmission revisions and controlled cancellation of approved leave (FR-026; DF03; DF05; BR-031).
-- DF03: returned requests create a new immutable revision on resubmission; approved changes need a controlled
-- reversal/cancellation action. Cancellation is its own approved transaction; its approval restores consumed
-- units by an append-only REVERSAL movement and never edits the original consumption.

-- A kind may share another kind's routing (explicit HR fallback list) without duplicating configuration.
alter table transaction_kind add column routing_kind text references transaction_kind (kind) on delete restrict;

-- DB031a leave_request_revision: what each submission asked for; reasons stay in the confidential reason group.
create table leave_request_revision (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references company (id) on delete restrict,
  request_id       uuid not null,
  revision         integer not null check (revision > 0),
  policy_id        uuid not null,
  start_date       date not null,
  end_date         date not null,
  half_day         boolean not null,
  requested_units  numeric(12, 4) not null check (requested_units > 0),
  reason           text,
  created_at       timestamptz not null default now(),
  created_by       uuid references user_account (id) on delete restrict,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references user_account (id) on delete restrict,
  version          integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, request_id, revision),
  foreign key (company_id, request_id) references leave_request (company_id, id) on delete restrict,
  check (end_date >= start_date)
);
create trigger leave_request_revision_append_only before update or delete on leave_request_revision
  for each row execute function hrms_append_only();

-- Existing requests get their submitted values as revision 1.
insert into leave_request_revision (company_id, request_id, revision, policy_id, start_date, end_date, half_day, requested_units, reason, created_at, created_by, updated_by)
select lr.company_id, lr.id, 1, lr.policy_id, lr.start_date, lr.end_date, lr.half_day, lr.requested_units, lr.reason, lr.created_at, lr.created_by, lr.created_by
  from leave_request lr;

-- DB031b leave_cancellation (typed root of kind leave_cancellation).
alter table leave_request add constraint leave_request_company_id_employee_key unique (company_id, id, employee_id);
create table leave_cancellation (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references company (id) on delete restrict,
  employee_id       uuid not null,
  leave_request_id  uuid not null,
  transaction_kind  text not null default 'leave_cancellation' check (transaction_kind = 'leave_cancellation'),
  transaction_id    uuid not null,
  reason            text not null check (btrim(reason) <> '' and length(reason) <= 1000),
  state             text not null check (state in ('SUBMITTED', 'APPROVED', 'REJECTED', 'WITHDRAWN')),
  created_at        timestamptz not null default now(),
  created_by        uuid references user_account (id) on delete restrict,
  updated_at        timestamptz not null default now(),
  updated_by        uuid references user_account (id) on delete restrict,
  version           integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, transaction_id),
  -- CI08: the cancellation belongs to the leave request's own employee.
  foreign key (company_id, leave_request_id, employee_id) references leave_request (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, transaction_kind, transaction_id) references business_transaction (company_id, kind, id)
    on delete restrict deferrable initially deferred
);
-- One open cancellation per leave request; at most one approved cancellation ever.
create unique index leave_cancellation_one_open on leave_cancellation (company_id, leave_request_id) where (state = 'SUBMITTED');
create unique index leave_cancellation_one_approved on leave_cancellation (company_id, leave_request_id) where (state = 'APPROVED');

insert into transaction_kind (kind, root_table, routing_kind) values ('leave_cancellation', 'leave_cancellation', 'leave_request');
insert into transaction_state (kind, state, initial, terminal) values
  ('leave_cancellation', 'SUBMITTED', true,  false),
  ('leave_cancellation', 'APPROVED',  false, true),
  ('leave_cancellation', 'REJECTED',  false, true),
  ('leave_cancellation', 'WITHDRAWN', false, true);
insert into transaction_transition (kind, from_state, to_state) values
  ('leave_cancellation', 'SUBMITTED', 'APPROVED'),
  ('leave_cancellation', 'SUBMITTED', 'REJECTED'),
  ('leave_cancellation', 'SUBMITTED', 'WITHDRAWN');

create function hrms_leave_cancellation_mirror() returns trigger language plpgsql as $$
declare
  bt_state text;
begin
  select state into bt_state from business_transaction where company_id = new.company_id and id = new.transaction_id;
  if bt_state is distinct from new.state then
    raise exception 'leave cancellation state % does not match its transaction state %', new.state, bt_state using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger leave_cancellation_mirrors_transaction
  after insert or update on leave_cancellation deferrable initially deferred
  for each row execute function hrms_leave_cancellation_mirror();

-- An approved cancellation and the CANCELLED leave request always go together (checked at commit).
create function hrms_leave_cancellation_consistent() returns trigger language plpgsql as $$
begin
  if new.state = 'CANCELLED' and not exists (
       select 1 from leave_cancellation c where c.company_id = new.company_id and c.leave_request_id = new.id and c.state = 'APPROVED') then
    raise exception 'an approved leave request can be cancelled only through an approved cancellation' using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger leave_request_cancelled_by_approval
  after update of state on leave_request deferrable initially deferred
  for each row execute function hrms_leave_cancellation_consistent();

create trigger leave_cancellation_touch before update on leave_cancellation for each row execute function hrms_touch();
create trigger leave_cancellation_no_delete before delete on leave_cancellation for each row execute function hrms_no_delete();

insert into permission (resource, action, field_group) values ('leave', 'cancel', 'operational');
