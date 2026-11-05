-- 0130 Arrears cases and the arrear register (FR-035; DF05 "unique employee/revision/period keys"; DF15 "retroactive difference
-- creates an approved arrears case, rather than reopening/overwriting"; BR-047; CI25).
--
-- One case per employee, source salary revision and processed period, with the amounts per pay component that a person enters
-- and an independent person decides. Nothing here calculates arrears, and an approved case pays nothing: there is no target run
-- and no line, the calculation never reads these tables, and how an arrear reaches payroll, how closed periods and tax
-- differences are treated (FR-035 "Decide") and the formula (OQ-07) are the owner's. DB111 requires a source timesheet and one
-- target line, so arrears, with a salary revision for a source and component detail, have their own tables.
--
-- SUBMITTED -> APPROVED, RETURNED or REJECTED. A returned or rejected case ends and frees its key; the new case links back.
create table payroll_arrears_case (
  id                        uuid primary key default gen_random_uuid(),
  company_id                uuid not null references company (id) on delete restrict,
  employee_id               uuid not null,
  transaction_kind          text not null default 'payroll_arrears_case' check (transaction_kind = 'payroll_arrears_case'),
  transaction_id            uuid not null,
  -- FR-035 "source revision": the approved effective salary revision whose difference this is.
  source_arrangement_id     uuid not null,
  -- FR-035 "period": the processed record the revision did not reach, and its period (the month of the detail).
  origin_payroll_record_id  uuid not null,
  origin_run_id             uuid not null,
  origin_period_id          uuid not null,
  currency_code             text not null check (currency_code ~ '^[A-Z]{3}$'),
  reason                    text not null check (btrim(reason) <> '' and length(reason) <= 2000),
  submit_key                text not null check (length(submit_key) between 8 and 100),
  state                     text not null check (state in ('SUBMITTED', 'APPROVED', 'RETURNED', 'REJECTED')),
  follows_case_id           uuid,
  decided_at                timestamptz,
  decided_by                uuid references user_account (id) on delete restrict,
  created_at                timestamptz not null default now(),
  created_by                uuid references user_account (id) on delete restrict,
  updated_at                timestamptz not null default now(),
  updated_by                uuid references user_account (id) on delete restrict,
  version                   integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, id, employee_id),
  unique (company_id, transaction_id),
  unique (company_id, submit_key),
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict,
  foreign key (company_id, source_arrangement_id, employee_id) references salary_arrangement (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, origin_payroll_record_id, employee_id) references payroll_record (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, origin_payroll_record_id, origin_run_id) references payroll_record (company_id, id, run_id) on delete restrict,
  foreign key (company_id, origin_period_id) references payroll_period (company_id, id) on delete restrict,
  foreign key (company_id, transaction_kind, transaction_id) references business_transaction (company_id, kind, id)
    on delete restrict deferrable initially deferred,
  foreign key (company_id, follows_case_id, employee_id) references payroll_arrears_case (company_id, id, employee_id) on delete restrict,
  check (follows_case_id is null or follows_case_id <> id),
  check ((state = 'SUBMITTED') = (decided_at is null)),
  check ((decided_at is null) = (decided_by is null))
);
-- FR-035 "rerunning the same revision does not pay the same arrears twice"; DF05 "unique employee/revision/period keys".
create unique index payroll_arrears_one_live on payroll_arrears_case (company_id, employee_id, source_arrangement_id, origin_period_id) where (state in ('SUBMITTED', 'APPROVED'));
create unique index payroll_arrears_one_successor on payroll_arrears_case (company_id, follows_case_id) where (follows_case_id is not null);
create index payroll_arrears_employee_idx on payroll_arrears_case (company_id, employee_id, created_at desc);
create index payroll_arrears_state_idx on payroll_arrears_case (company_id, state, created_at desc);

create function hrms_payroll_arrears_guard() returns trigger language plpgsql as $$
declare
  ru record;
  sa record;
begin
  if tg_op = 'INSERT' then
    if new.state <> 'SUBMITTED' then
      raise exception 'an arrears case starts as submitted' using errcode = '23514';
    end if;
    select state, period_id, service_start, service_end, currency_code into ru from payroll_run where company_id = new.company_id and id = new.origin_run_id;
    if ru.state is distinct from 'PROCESSED_LOCKED' then
      raise exception 'an arrears case originates in a processed payroll' using errcode = '23514';
    end if;
    if ru.period_id <> new.origin_period_id or ru.currency_code <> new.currency_code then
      raise exception 'an arrears case carries the period and currency of its origin run' using errcode = '23514';
    end if;
    select effective_from, effective_to, currency_code, superseded_at into sa from salary_arrangement where company_id = new.company_id and id = new.source_arrangement_id;
    if sa.superseded_at is not null or sa.currency_code <> new.currency_code then
      raise exception 'the source revision is superseded or in another currency' using errcode = '23514';
    end if;
    -- effective_to is exclusive (0011).
    if sa.effective_from > ru.service_end or (sa.effective_to is not null and sa.effective_to <= ru.service_start) then
      raise exception 'the source revision does not cover the origin period' using errcode = '23514';
    end if;
    -- A revision the record was calculated from left no difference.
    if exists (select 1 from payroll_record_segment s where s.company_id = new.company_id and s.record_id = new.origin_payroll_record_id and s.salary_arrangement_id = new.source_arrangement_id) then
      raise exception 'the origin record was already calculated from this revision' using errcode = '23514';
    end if;
    return new;
  end if;
  if (new.employee_id, new.transaction_id, new.source_arrangement_id, new.origin_payroll_record_id, new.origin_run_id, new.origin_period_id,
      new.currency_code, new.reason, new.submit_key, new.follows_case_id)
     is distinct from
     (old.employee_id, old.transaction_id, old.source_arrangement_id, old.origin_payroll_record_id, old.origin_run_id, old.origin_period_id,
      old.currency_code, old.reason, old.submit_key, old.follows_case_id) then
    raise exception 'a submitted arrears case is immutable' using errcode = '23514';
  end if;
  if old.state <> 'SUBMITTED' then
    raise exception 'the decision on an arrears case is final' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger payroll_arrears_case_guard before insert or update on payroll_arrears_case for each row execute function hrms_payroll_arrears_guard();
create trigger payroll_arrears_case_touch before update on payroll_arrears_case for each row execute function hrms_touch();
create trigger payroll_arrears_case_no_delete before delete on payroll_arrears_case for each row execute function hrms_no_delete();
create constraint trigger payroll_arrears_case_mirrors_transaction after insert or update on payroll_arrears_case
  deferrable initially deferred for each row execute function hrms_payroll_mirror();

-- FR-035 "component and month detail" (the month is the case's period). Entered with the case, signed, never computed; a zero
-- line says nothing. A negative line stays a record: approving it needs a recovery policy (H2), which does not exist.
create table payroll_arrears_line (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references company (id) on delete restrict,
  case_id       uuid not null,
  component_id  uuid not null,
  amount        numeric(19, 4) not null check (amount <> 0),
  created_at    timestamptz not null default now(),
  created_by    uuid references user_account (id) on delete restrict,
  unique (company_id, case_id, component_id),
  foreign key (company_id, case_id) references payroll_arrears_case (company_id, id) on delete restrict,
  foreign key (company_id, component_id) references pay_component (company_id, id) on delete restrict
);

create function hrms_payroll_arrears_line_guard() returns trigger language plpgsql as $$
begin
  if (select state from payroll_arrears_case where company_id = new.company_id and id = new.case_id) is distinct from 'SUBMITTED' then
    raise exception 'the detail of an arrears case is fixed before its decision' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger payroll_arrears_line_guard before insert on payroll_arrears_line for each row execute function hrms_payroll_arrears_line_guard();
create trigger payroll_arrears_line_append_only before update or delete on payroll_arrears_line for each row execute function hrms_append_only();

insert into transaction_kind (kind, root_table, routing_kind) values ('payroll_arrears_case', 'payroll_arrears_case', null);
insert into transaction_state (kind, state, initial, terminal) values
  ('payroll_arrears_case', 'SUBMITTED', true,  false),
  ('payroll_arrears_case', 'APPROVED',  false, true),
  ('payroll_arrears_case', 'RETURNED',  false, true),
  ('payroll_arrears_case', 'REJECTED',  false, true);
insert into transaction_transition (kind, from_state, to_state) values
  ('payroll_arrears_case', 'SUBMITTED', 'APPROVED'),
  ('payroll_arrears_case', 'SUBMITTED', 'RETURNED'),
  ('payroll_arrears_case', 'SUBMITTED', 'REJECTED');

insert into permission (resource, action, field_group, own_ess) values
  ('payroll_arrears', 'read',    'amount', false),
  ('payroll_arrears', 'propose', 'amount', false),
  ('payroll_arrears', 'decide',  'amount', false);
