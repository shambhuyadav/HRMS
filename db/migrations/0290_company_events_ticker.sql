-- 0290 Company events and ticker messages (BRD coverage CL-021 "Event planner" and CL-022 "Ticker message", under FR-001 and FR-096;
-- built 11 Nov 2026 from the reference screen's structure; decided under owner delegation, 6 Nov 2026).
--
-- company_event: a company event (name, description, date) for everyone, or for one department or one location; shown to the people
-- it is for on their dashboard while it is upcoming. ticker_message: a short company announcement shown as a banner on everyone's
-- dashboard from its first day to its last day (both included). Both are kept, never deleted: HR switches one off (active = false),
-- and every change is audited. Neither holds anything about an employee.
--
-- Permissions:
--   announcement.read.operational     every baseline role's default duty: what a person is shown on their dashboard (the
--                                     server picks only what is for them);
--   announcement.manage.operational   a default duty of the HR Administrator: create, change and switch off events and messages.
--
-- To reverse: drop both tables and the two permissions added here.

create table company_event (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references company (id) on delete restrict,
  name           text not null check (btrim(name) <> '' and length(name) <= 120),
  description    text check (description is null or (btrim(description) <> '' and length(description) <= 1000)),
  event_date     date not null,
  audience       text not null default 'ALL' check (audience in ('ALL', 'DEPARTMENT', 'LOCATION')),
  department_id  uuid,
  location_id    uuid,
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  created_by     uuid not null references user_account (id) on delete restrict,
  updated_at     timestamptz not null default now(),
  updated_by     uuid not null references user_account (id) on delete restrict,
  version        integer not null default 1 check (version > 0),
  unique (company_id, id),
  foreign key (company_id, department_id) references department (company_id, id) on delete restrict,
  foreign key (company_id, location_id) references location (company_id, id) on delete restrict,
  check ((audience = 'ALL' and department_id is null and location_id is null)
      or (audience = 'DEPARTMENT' and department_id is not null and location_id is null)
      or (audience = 'LOCATION' and location_id is not null and department_id is null))
);
create index company_event_date_idx on company_event (company_id, event_date);
create index company_event_department_idx on company_event (company_id, department_id) where department_id is not null;
create index company_event_location_idx on company_event (company_id, location_id) where location_id is not null;

create table ticker_message (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references company (id) on delete restrict,
  message     text not null check (btrim(message) <> '' and length(message) <= 280),
  -- Shown from starts_on to ends_on, both included.
  starts_on   date not null,
  ends_on     date not null check (ends_on >= starts_on),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  created_by  uuid not null references user_account (id) on delete restrict,
  updated_at  timestamptz not null default now(),
  updated_by  uuid not null references user_account (id) on delete restrict,
  version     integer not null default 1 check (version > 0),
  unique (company_id, id)
);
create index ticker_message_period_idx on ticker_message (company_id, starts_on, ends_on);

-- Kept, never deleted: switching off is the end of an event or a message.
create function hrms_announcement_no_delete() returns trigger language plpgsql as $$
begin
  raise exception '% rows are never deleted; switch them off instead', tg_table_name using errcode = '23514';
end $$;
create trigger company_event_no_delete before delete on company_event for each row execute function hrms_announcement_no_delete();
create trigger ticker_message_no_delete before delete on ticker_message for each row execute function hrms_announcement_no_delete();

insert into permission (resource, action, field_group) values
  ('announcement', 'read', 'operational'),
  ('announcement', 'manage', 'operational')
on conflict do nothing;

-- Ceilings of every company's roles (new companies get them from modules/announcements/registration.ts): every baseline role reads,
-- the HR Administrator also manages. Existing approved assignments keep their frozen allowlists (0099) until a new assignment or
-- grant adds them.
insert into role_permission (company_id, role_id, permission_id, effect)
select r.company_id, r.id, p.id, 'ALLOW'
  from role r
  join permission p on (p.resource, p.action, p.field_group) = ('announcement', 'read', 'operational')
 where r.code in ('SYSTEM_ADMINISTRATOR', 'HR_ADMINISTRATOR', 'REPORTING_MANAGER', 'EMPLOYEE', 'PAYROLL_OPERATOR', 'PAYROLL_APPROVER', 'FINANCE_REVIEWER',
                  'EXPENSE_FINANCE_APPROVER', 'TREASURY_OPERATOR', 'TREASURY_APPROVER', 'RECRUITER', 'APPRAISAL_REVIEWER', 'TRAINING_COORDINATOR', 'AUDITOR')
on conflict (company_id, role_id, permission_id) do nothing;

insert into role_permission (company_id, role_id, permission_id, effect)
select r.company_id, r.id, p.id, 'ALLOW'
  from role r
  join permission p on (p.resource, p.action, p.field_group) = ('announcement', 'manage', 'operational')
 where r.code = 'HR_ADMINISTRATOR'
on conflict (company_id, role_id, permission_id) do nothing;
