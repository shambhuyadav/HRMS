-- 0101 Employee status history, joining-date corrections and prior employment (FR-006 "status history", acceptance "joining
-- and status changes retain effective-dated history"; BR-002; CI15; DF04 "a new employment links to the prior one").
--
-- employee_status_history  append-only, one row per status an employee was put in. The trigger on employee is the only
--                          writer, so no path can change a status without a row, whoever writes it. The application says
--                          what the change is through the transaction-local setting hrms.employee_status_source (a JSON
--                          object: kind, effectiveDate, sourceId; employee/status.ts withStatusSource). Without one a new
--                          row is CREATE and an update is DIRECT, dated the business date.
--                          The effective date is the business date the status applies from and can lie before or after
--                          the moment it was recorded (a back-dated joining, an activation ahead of the joining date), so
--                          this is an event list ordered by recorded_at, not a set of non-overlapping periods.
-- employee_joining_date_change  append-only record of each corrected joining date (BR-002 "retain ... prior history").
-- employee.prior_employee_id    the employment a rehire follows, inside one company, set once at creation, at most one
--                               successor. A move between companies is OPEN (docs/03).

create table employee_status_history (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references company (id) on delete restrict,
  employee_id      uuid not null,
  status_category  text not null default 'EMPLOYEE_STATUS' check (status_category = 'EMPLOYEE_STATUS'),
  status_id        uuid not null,
  prior_status_id  uuid,
  effective_date   date not null,
  source_kind      text not null check (source_kind in ('CREATE', 'ACTIVATION', 'CONFIRMATION', 'EXIT_APPROVED', 'EXIT_WITHDRAWN', 'SEPARATION', 'DRAFT_CLOSED', 'DIRECT', 'BASELINE')),
  source_id        uuid,
  actor_user_id    uuid references user_account (id) on delete restrict,
  recorded_at      timestamptz not null default clock_timestamp(),
  unique (company_id, id),
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict,
  foreign key (company_id, status_category, status_id) references reference_value (company_id, category, id) on delete restrict,
  foreign key (company_id, status_category, prior_status_id) references reference_value (company_id, category, id) on delete restrict
);
create index employee_status_history_employee_idx on employee_status_history (company_id, employee_id, recorded_at);

create trigger employee_status_history_append_only before update or delete on employee_status_history
  for each row execute function hrms_append_only();
create trigger employee_status_history_no_truncate before truncate on employee_status_history
  for each statement execute function hrms_no_truncate();

-- Baseline for employees that exist already: their current status only (earlier changes live in audit_event and the module
-- tables), dated by the record that shows when it applied. A status with no such record takes the date of the last change.
insert into employee_status_history (company_id, employee_id, status_id, effective_date, source_kind, actor_user_id, recorded_at)
select e.company_id, e.id, e.status_id,
       case st.code
         when 'DRAFT' then least(e.joining_date, hrms_business_date(e.company_id, e.created_at))
         when 'ACTIVE_PROBATION' then e.joining_date
         when 'ACTIVE_CONFIRMED' then coalesce(e.confirmation_date, e.joining_date)
         when 'NOTICE' then coalesce(hrms_business_date(e.company_id, x.approved_at), hrms_business_date(e.company_id, e.updated_at))
         when 'INACTIVE_SEPARATED' then coalesce(x.approved_leaving_date + 1, hrms_business_date(e.company_id, e.updated_at))
         else hrms_business_date(e.company_id, e.updated_at)
       end,
       'BASELINE', e.updated_by, e.updated_at
  from employee e
  join reference_value st on st.company_id = e.company_id and st.id = e.status_id
  left join lateral (
    select c.approved_at, c.approved_leaving_date
      from exit_case c
     where c.company_id = e.company_id and c.employee_id = e.id and c.state in ('APPROVED', 'SEPARATED')
     order by c.approved_at desc nulls last
     limit 1) x on true;

create function hrms_employee_status_record() returns trigger language plpgsql as $$
declare
  source jsonb := nullif(current_setting('hrms.employee_status_source', true), '')::jsonb;
  today date := hrms_business_date(new.company_id, now());
begin
  if tg_op = 'UPDATE' and new.status_id is not distinct from old.status_id then
    return null;
  end if;
  insert into employee_status_history (company_id, employee_id, status_id, prior_status_id, effective_date, source_kind, source_id, actor_user_id)
  values (
    new.company_id,
    new.id,
    new.status_id,
    case when tg_op = 'UPDATE' then old.status_id end,
    coalesce((source ->> 'effectiveDate')::date, case when tg_op = 'INSERT' then least(new.joining_date, today) else today end),
    coalesce(source ->> 'kind', case when tg_op = 'INSERT' then 'CREATE' else 'DIRECT' end),
    (source ->> 'sourceId')::uuid,
    coalesce(new.updated_by, new.created_by)
  );
  return null;
end $$;

create trigger employee_status_record after insert or update of status_id on employee
  for each row execute function hrms_employee_status_record();

create table employee_joining_date_change (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references company (id) on delete restrict,
  employee_id    uuid not null,
  prior_date     date not null,
  new_date       date not null check (new_date <> prior_date),
  actor_user_id  uuid not null references user_account (id) on delete restrict,
  recorded_at    timestamptz not null default clock_timestamp(),
  unique (company_id, id),
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict
);
create index employee_joining_date_change_employee_idx on employee_joining_date_change (company_id, employee_id, recorded_at);

create trigger employee_joining_date_change_append_only before update or delete on employee_joining_date_change
  for each row execute function hrms_append_only();
create trigger employee_joining_date_change_no_truncate before truncate on employee_joining_date_change
  for each statement execute function hrms_no_truncate();

alter table employee add column prior_employee_id uuid;
alter table employee add constraint employee_prior_employee_fk foreign key (company_id, prior_employee_id) references employee (company_id, id) on delete restrict;
alter table employee add constraint employee_prior_employee_not_self check (prior_employee_id <> id);
create unique index employee_prior_employee_uq on employee (company_id, prior_employee_id) where prior_employee_id is not null;

create function hrms_employee_prior_fixed() returns trigger language plpgsql as $$
begin
  if new.prior_employee_id is distinct from old.prior_employee_id then
    raise exception 'the prior employment of an employee is set when the record is created' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger employee_prior_fixed before update of prior_employee_id on employee
  for each row execute function hrms_employee_prior_fixed();
