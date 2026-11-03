-- 0042 Confirmation exceptions (DF11; FR-080, FR-081; BR-029). "Company default -> employee-type/grade policy ->
-- independently approved employee override (highest priority)" and "maximum two extensions unless a separately
-- recorded exception approval authorises more". HR proposes, a different eligible HR user decides; the employee
-- never decides. A due-date override sets the case's override due date (columns from 0009); an extra-extension
-- exception raises that case's extension limit by one. Proposals and decisions are kept; nothing is overwritten.

alter table employee_confirmation add column extra_extensions integer not null default 0 check (extra_extensions >= 0);

create table confirmation_exception (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references company (id) on delete restrict,
  confirmation_id    uuid not null,
  employee_id        uuid not null,
  kind               text not null check (kind in ('DUE_DATE_OVERRIDE', 'EXTRA_EXTENSION')),
  proposed_due_date  date,
  -- Private justification (the confirmation `reason` group, 0020).
  reason             text not null check (btrim(reason) <> '' and length(reason) <= 1000),
  state              text not null default 'PROPOSED' check (state in ('PROPOSED', 'APPROVED', 'REJECTED', 'WITHDRAWN')),
  proposed_by        uuid not null references user_account (id) on delete restrict,
  decided_by         uuid references user_account (id) on delete restrict,
  decided_at         timestamptz,
  decision_reason    text check (decision_reason is null or (btrim(decision_reason) <> '' and length(decision_reason) <= 1000)),
  created_at         timestamptz not null default now(),
  created_by         uuid references user_account (id) on delete restrict,
  updated_at         timestamptz not null default now(),
  updated_by         uuid references user_account (id) on delete restrict,
  version            integer not null default 1 check (version > 0),
  unique (company_id, id),
  foreign key (company_id, confirmation_id, employee_id) references employee_confirmation (company_id, id, employee_id) on delete restrict,
  check ((kind = 'DUE_DATE_OVERRIDE') = (proposed_due_date is not null)),
  -- Independent decision: never by the proposer (C4).
  check (decided_by is null or decided_by <> proposed_by),
  check ((state in ('APPROVED', 'REJECTED')) = (decided_by is not null and decided_at is not null and decision_reason is not null))
);
-- One open proposal per case and kind.
create unique index confirmation_exception_one_open on confirmation_exception (company_id, confirmation_id, kind) where (state = 'PROPOSED');

-- Decided or withdrawn proposals are final; identity and content never change.
create function hrms_confirmation_exception_guard() returns trigger language plpgsql as $$
begin
  if (new.confirmation_id, new.employee_id, new.kind, new.proposed_due_date, new.reason, new.proposed_by)
     is distinct from (old.confirmation_id, old.employee_id, old.kind, old.proposed_due_date, old.reason, old.proposed_by) then
    raise exception 'a confirmation exception proposal is immutable' using errcode = '23514';
  end if;
  if old.state <> 'PROPOSED' and new.state is distinct from old.state then
    raise exception 'confirmation exception in % is final', old.state using errcode = '23514';
  end if;
  return new;
end $$;

create trigger confirmation_exception_guard before update on confirmation_exception for each row execute function hrms_confirmation_exception_guard();
create trigger confirmation_exception_touch before update on confirmation_exception for each row execute function hrms_touch();
create trigger confirmation_exception_no_delete before delete on confirmation_exception for each row execute function hrms_no_delete();

insert into permission (resource, action, field_group) values
  ('confirmation', 'propose_exception', 'operational'),
  ('confirmation', 'approve_exception', 'operational');
