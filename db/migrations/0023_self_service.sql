-- 0023 Employee self-service change requests (FR-059; DF02; DF03; DF04) and reviewer-routing administration (DF03).
-- DF04: "An ordinary employee submits change requests for permitted operational fields; confidential field
-- maintenance belongs to eligible Admins." FR-059: change requests never alter protected master fields without
-- authorised review. DF03: attendance amendments route to the direct manager, else the HR fallback list.

create function hrms_self_service_mirror() returns trigger language plpgsql as $$
declare
  bt_state text;
begin
  select state into bt_state from business_transaction where company_id = new.company_id and id = new.transaction_id;
  if bt_state is distinct from new.state then
    raise exception '% state % does not match its transaction state %', tg_table_name, new.state, bt_state using errcode = '23514';
  end if;
  return null;
end $$;

-- Profile change request: only permitted operational fields, as requested values plus the values seen at request.
create table profile_change_request (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references company (id) on delete restrict,
  employee_id       uuid not null,
  transaction_kind  text not null default 'profile_change' check (transaction_kind = 'profile_change'),
  transaction_id    uuid not null,
  requested         jsonb not null check (jsonb_typeof(requested) = 'object' and requested <> '{}'::jsonb
                                          and requested - array['displayName', 'workEmail'] = '{}'::jsonb),
  current_values    jsonb not null check (jsonb_typeof(current_values) = 'object'),
  state             text not null check (state in ('SUBMITTED', 'APPROVED', 'REJECTED', 'WITHDRAWN')),
  applied_at        timestamptz,
  created_at        timestamptz not null default now(),
  created_by        uuid references user_account (id) on delete restrict,
  updated_at        timestamptz not null default now(),
  updated_by        uuid references user_account (id) on delete restrict,
  version           integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, transaction_id),
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict,
  foreign key (company_id, transaction_kind, transaction_id) references business_transaction (company_id, kind, id)
    on delete restrict deferrable initially deferred,
  check ((state = 'APPROVED') = (applied_at is not null))
);
-- One open request per employee keeps reviews unambiguous.
create unique index profile_change_one_open on profile_change_request (company_id, employee_id) where (state = 'SUBMITTED');

-- Attendance correction request: the employee asks for a different status on one of their own records.
create table attendance_correction_request (
  id                      uuid primary key default gen_random_uuid(),
  company_id              uuid not null references company (id) on delete restrict,
  employee_id             uuid not null,
  attendance_record_id    uuid not null,
  transaction_kind        text not null default 'attendance_correction' check (transaction_kind = 'attendance_correction'),
  transaction_id          uuid not null,
  status_category         text not null default 'ATTENDANCE_STATUS' check (status_category = 'ATTENDANCE_STATUS'),
  requested_status_id     uuid not null,
  -- Private reason: the confidential attendance `reason` group (0020).
  reason                  text not null check (btrim(reason) <> '' and length(reason) <= 1000),
  state                   text not null check (state in ('SUBMITTED', 'APPROVED', 'REJECTED', 'WITHDRAWN')),
  created_at              timestamptz not null default now(),
  created_by              uuid references user_account (id) on delete restrict,
  updated_at              timestamptz not null default now(),
  updated_by              uuid references user_account (id) on delete restrict,
  version                 integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, transaction_id),
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict,
  foreign key (company_id, status_category, requested_status_id) references reference_value (company_id, category, id) on delete restrict,
  foreign key (company_id, transaction_kind, transaction_id) references business_transaction (company_id, kind, id)
    on delete restrict deferrable initially deferred
);
alter table attendance_record add constraint attendance_record_company_id_employee_key unique (company_id, id, employee_id);
-- CI08: the record belongs to the requesting employee.
alter table attendance_correction_request add constraint attendance_correction_record_fk
  foreign key (company_id, attendance_record_id, employee_id) references attendance_record (company_id, id, employee_id) on delete restrict;
create unique index attendance_correction_one_open on attendance_correction_request (company_id, attendance_record_id) where (state = 'SUBMITTED');

do $$
declare
  t text;
begin
  foreach t in array array['profile_change_request', 'attendance_correction_request'] loop
    execute format('create constraint trigger %I after insert or update on %I deferrable initially deferred for each row execute function hrms_self_service_mirror()',
                   t || '_mirrors_transaction', t);
    execute format('create trigger %I before update on %I for each row execute function hrms_touch()', t || '_touch', t);
    execute format('create trigger %I before delete on %I for each row execute function hrms_no_delete()', t || '_no_delete', t);
  end loop;
end $$;

-- Profile changes have their own HR fallback list; corrections route like leave (direct manager, then leave's list).
insert into transaction_kind (kind, root_table, routing_kind) values
  ('profile_change', 'profile_change_request', null),
  ('attendance_correction', 'attendance_correction_request', 'leave_request');
insert into transaction_state (kind, state, initial, terminal)
select k, s.state, s.initial, s.terminal
  from unnest(array['profile_change', 'attendance_correction']) as k,
       (values ('SUBMITTED', true, false), ('APPROVED', false, true), ('REJECTED', false, true), ('WITHDRAWN', false, true)) as s (state, initial, terminal);
insert into transaction_transition (kind, from_state, to_state)
select k, 'SUBMITTED', t
  from unnest(array['profile_change', 'attendance_correction']) as k, unnest(array['APPROVED', 'REJECTED', 'WITHDRAWN']) as t;

insert into permission (resource, action, field_group) values
  ('profile_change', 'submit',  'operational'),
  ('profile_change', 'read',    'operational'),
  ('attendance', 'request_correction', 'operational'),
  ('attendance', 'approve_correction', 'operational');
