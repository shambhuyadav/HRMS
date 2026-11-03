-- 0046 Loans and salary advances (FR-034; H3 TN15) on top of payroll outputs (0045).
--
-- A loan or advance is requested by the employee (own ESS) or entered by an eligible Admin for the employee, decided
-- by an independent eligible Admin (never the requester or the beneficiary), disbursed only on recorded evidence by a
-- further independent Admin (nothing is marked disbursed otherwise, DF07), and recovered only from frozen payroll:
-- a recovery is the processed (PROCESSED_LOCKED) payroll line of the loan's recovery deduction head for the employee,
-- recognised once per loan and record and never above the outstanding balance. A cancelled or returned run never
-- reaches PROCESSED_LOCKED, so it never advances recovery (FR-034 acceptance). No interest rate or early-settlement
-- rule is configured (FR-034 "define interest and early-settlement rules if required"), so loans carry no interest and
-- the schedule is the approved instalments only; the terms never change after approval (TN15 "no schedule edits").

create table payroll_loan (
  id                           uuid primary key default gen_random_uuid(),
  company_id                   uuid not null references company (id) on delete restrict,
  employee_id                  uuid not null,
  loan_kind                    text not null check (loan_kind in ('LOAN', 'ADVANCE')),
  request_origin               text not null check (request_origin in ('EMPLOYEE', 'ADMIN')),
  currency_code                text not null check (currency_code ~ '^[A-Z]{3}$'),
  principal                    numeric(19, 4) not null check (principal > 0),
  purpose                      text not null check (btrim(purpose) <> '' and length(purpose) <= 1000),
  idempotency_key              text check (idempotency_key is null or idempotency_key ~ '^[A-Za-z0-9._:-]{8,100}$'),
  state                        text not null default 'REQUESTED'
                               check (state in ('REQUESTED', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'CANCELLED', 'DISBURSED', 'CLOSED')),
  requested_by                 uuid not null references user_account (id) on delete restrict,
  requested_at                 timestamptz not null default now(),
  -- Terms fixed by the decision.
  recovery_component_id        uuid,
  decided_by                   uuid references user_account (id) on delete restrict,
  decided_assignment_id        uuid,
  decided_at                   timestamptz,
  decision_reason              text check (decision_reason is null or (btrim(decision_reason) <> '' and length(decision_reason) <= 1000)),
  -- Disbursement from evidence (DF07).
  disbursement_date            date,
  disbursement_evidence_key    text check (disbursement_evidence_key is null or disbursement_evidence_key ~ '^[A-Za-z0-9._:-]{8,100}$'),
  disbursement_reference       text check (disbursement_reference is null or (btrim(disbursement_reference) <> '' and length(disbursement_reference) <= 500)),
  disbursement_document_id     uuid,
  disbursed_by                 uuid references user_account (id) on delete restrict,
  disbursed_assignment_id      uuid,
  disbursed_at                 timestamptz,
  -- Maintained only by recognised recoveries (trigger below).
  recovered_amount             numeric(19, 4) not null default 0 check (recovered_amount >= 0),
  closed_at                    timestamptz,
  closed_by                    uuid references user_account (id) on delete restrict,
  close_reason                 text check (close_reason is null or (btrim(close_reason) <> '' and length(close_reason) <= 1000)),
  created_at                   timestamptz not null default now(),
  created_by                   uuid references user_account (id) on delete restrict,
  updated_at                   timestamptz not null default now(),
  updated_by                   uuid references user_account (id) on delete restrict,
  version                      integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, id, employee_id),
  unique (company_id, idempotency_key),
  unique (company_id, disbursement_evidence_key),
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict,
  foreign key (company_id, recovery_component_id) references pay_component (company_id, id) on delete restrict,
  foreign key (company_id, disbursement_document_id) references employee_document (company_id, id) on delete restrict,
  foreign key (company_id, decided_assignment_id) references role_assignment (company_id, id) on delete restrict,
  foreign key (company_id, disbursed_assignment_id) references role_assignment (company_id, id) on delete restrict,
  check (recovered_amount <= principal),
  -- C4 / TN15: the requester never decides; the decider never records the disbursement.
  check (decided_by is null or decided_by <> requested_by),
  check (disbursed_by is null or (disbursed_by <> requested_by and disbursed_by <> decided_by)),
  check ((decided_at is null) = (decided_by is null)),
  check ((state in ('REQUESTED', 'WITHDRAWN')) = (decided_at is null)),
  check (state not in ('APPROVED', 'DISBURSED', 'CLOSED') or recovery_component_id is not null),
  check (state <> 'REJECTED' or decision_reason is not null),
  check ((state in ('DISBURSED', 'CLOSED')) = (disbursed_at is not null)),
  check ((disbursed_at is null) = (disbursed_by is null) and (disbursed_at is null) = (disbursement_date is null)
         and (disbursed_at is null) = (disbursement_reference is null) and (disbursed_at is null) = (disbursement_evidence_key is null)
         and (disbursed_at is null) = (disbursement_document_id is null)),
  check ((state in ('CLOSED', 'WITHDRAWN', 'CANCELLED')) = (closed_at is not null)),
  check ((closed_at is null) = (closed_by is null) and (closed_at is null) = (close_reason is null)),
  check (state <> 'CLOSED' or recovered_amount = principal)
);
create index payroll_loan_employee_idx on payroll_loan (company_id, employee_id);
-- One live loan per employee and recovery head, so a recovery line belongs to exactly one loan.
create unique index payroll_loan_one_per_recovery_head on payroll_loan (company_id, employee_id, recovery_component_id)
  where (state in ('APPROVED', 'DISBURSED'));

create function hrms_payroll_loan_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.state <> 'REQUESTED' or new.decided_at is not null or new.disbursed_at is not null or new.recovered_amount <> 0 or new.recovery_component_id is not null then
      raise exception 'a loan starts as a request' using errcode = '23514';
    end if;
    return new;
  end if;
  if (new.employee_id, new.loan_kind, new.request_origin, new.currency_code, new.principal, new.purpose, new.idempotency_key, new.requested_by, new.requested_at)
     is distinct from (old.employee_id, old.loan_kind, old.request_origin, old.currency_code, old.principal, old.purpose, old.idempotency_key, old.requested_by, old.requested_at) then
    raise exception 'a loan request never changes after submission' using errcode = '23514';
  end if;
  if old.decided_at is not null and (new.recovery_component_id, new.decided_by, new.decided_assignment_id, new.decided_at, new.decision_reason)
     is distinct from (old.recovery_component_id, old.decided_by, old.decided_assignment_id, old.decided_at, old.decision_reason) then
    raise exception 'loan terms and decisions are recorded once' using errcode = '23514';
  end if;
  if old.disbursed_at is not null and (new.disbursement_date, new.disbursement_evidence_key, new.disbursement_reference, new.disbursement_document_id, new.disbursed_by,
      new.disbursed_assignment_id, new.disbursed_at)
     is distinct from (old.disbursement_date, old.disbursement_evidence_key, old.disbursement_reference, old.disbursement_document_id, old.disbursed_by,
      old.disbursed_assignment_id, old.disbursed_at) then
    raise exception 'a recorded disbursement never changes' using errcode = '23514';
  end if;
  if new.recovered_amount is distinct from old.recovered_amount and pg_trigger_depth() < 2 then
    raise exception 'recovered amounts change only through recognised recoveries' using errcode = '23514';
  end if;
  if new.state is distinct from old.state and not (
       (old.state = 'REQUESTED' and new.state in ('APPROVED', 'REJECTED', 'WITHDRAWN'))
    or (old.state = 'APPROVED' and new.state in ('DISBURSED', 'CANCELLED'))
    or (old.state = 'DISBURSED' and new.state = 'CLOSED')) then
    raise exception 'invalid loan transition % -> %', old.state, new.state using errcode = '23514';
  end if;
  return new;
end $$;
create trigger payroll_loan_guard before insert or update on payroll_loan for each row execute function hrms_payroll_loan_guard();

-- The approved recovery schedule: written once with the approval, never edited.
create table payroll_loan_installment (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references company (id) on delete restrict,
  loan_id        uuid not null,
  sequence       integer not null check (sequence > 0),
  due_month      date not null check (extract(day from due_month) = 1),
  amount         numeric(19, 4) not null check (amount > 0),
  created_at     timestamptz not null default now(),
  created_by     uuid references user_account (id) on delete restrict,
  unique (company_id, id),
  unique (company_id, loan_id, sequence),
  unique (company_id, loan_id, due_month),
  foreign key (company_id, loan_id) references payroll_loan (company_id, id) on delete restrict
);
create trigger payroll_loan_installment_append_only before update or delete on payroll_loan_installment for each row execute function hrms_append_only();

create function hrms_payroll_loan_schedule_check() returns trigger language plpgsql as $$
declare
  l payroll_loan%rowtype;
  total numeric;
  n integer;
begin
  select * into l from payroll_loan where company_id = new.company_id and id = new.loan_id;
  if l.state not in ('REQUESTED', 'APPROVED') then
    raise exception 'a schedule is written with the approval only' using errcode = '23514';
  end if;
  select coalesce(sum(amount), 0), count(*) into total, n from payroll_loan_installment where company_id = new.company_id and loan_id = new.loan_id;
  if l.state = 'REQUESTED' or total <> l.principal then
    raise exception 'an approved schedule recovers exactly the principal' using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger payroll_loan_schedule_total after insert on payroll_loan_installment deferrable initially deferred
  for each row execute function hrms_payroll_loan_schedule_check();

-- Recoveries recognised from frozen payroll lines (append-only).
create table payroll_loan_recovery (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references company (id) on delete restrict,
  loan_id             uuid not null,
  employee_id         uuid not null,
  payroll_record_id   uuid not null,
  run_id              uuid not null,
  payroll_line_id     uuid not null,
  amount              numeric(19, 4) not null check (amount > 0),
  currency_code       text not null check (currency_code ~ '^[A-Z]{3}$'),
  recorded_by         uuid not null references user_account (id) on delete restrict,
  created_at          timestamptz not null default now(),
  unique (company_id, id),
  -- A processed record recovers a loan once; a payroll line pays one loan once.
  unique (company_id, loan_id, payroll_record_id),
  unique (company_id, payroll_line_id),
  foreign key (company_id, loan_id, employee_id) references payroll_loan (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, payroll_record_id, employee_id) references payroll_record (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, payroll_record_id, run_id) references payroll_record (company_id, id, run_id) on delete restrict,
  foreign key (company_id, payroll_line_id) references payroll_line (company_id, id) on delete restrict
);
create index payroll_loan_recovery_loan_idx on payroll_loan_recovery (company_id, loan_id);

create function hrms_payroll_loan_recovery_apply() returns trigger language plpgsql as $$
declare
  l payroll_loan%rowtype;
  run_state text;
  frozen timestamptz;
  line_record uuid;
  line_component uuid;
  line_amount numeric;
begin
  select * into l from payroll_loan where company_id = new.company_id and id = new.loan_id for update;
  select ru.state, r.frozen_at into run_state, frozen
    from payroll_record r join payroll_run ru on ru.company_id = r.company_id and ru.id = r.run_id
   where r.company_id = new.company_id and r.id = new.payroll_record_id;
  select record_id, component_id, amount into line_record, line_component, line_amount from payroll_line where company_id = new.company_id and id = new.payroll_line_id;
  if run_state is distinct from 'PROCESSED_LOCKED' or frozen is null then
    raise exception 'a recovery comes from a frozen record of a processed run only' using errcode = '23514';
  end if;
  if l.state <> 'DISBURSED' or line_record is distinct from new.payroll_record_id or line_component is distinct from l.recovery_component_id
     or line_amount is distinct from new.amount or new.currency_code <> l.currency_code then
    raise exception 'a recovery is the processed line of the disbursed loan''s recovery head' using errcode = '23514';
  end if;
  if new.amount > l.principal - l.recovered_amount then
    raise exception 'a recovery never exceeds the outstanding balance' using errcode = '23514';
  end if;
  update payroll_loan set recovered_amount = recovered_amount + new.amount, updated_by = new.recorded_by where company_id = new.company_id and id = new.loan_id;
  return new;
end $$;
create trigger payroll_loan_recovery_apply before insert on payroll_loan_recovery for each row execute function hrms_payroll_loan_recovery_apply();
create trigger payroll_loan_recovery_append_only before update or delete on payroll_loan_recovery for each row execute function hrms_append_only();

create trigger payroll_loan_touch before update on payroll_loan for each row execute function hrms_touch();
create trigger payroll_loan_no_delete before delete on payroll_loan for each row execute function hrms_no_delete();

-- Permission catalogue: loan values are confidential (eligible Admin grants, DF02); the Employee OWN context reads and
-- requests its own loans (own-ESS, H1/BR-053; TN15).
insert into permission (resource, action, field_group, own_ess) values
  ('payroll_loan', 'read',     'loan', false),
  ('payroll_loan', 'request',  'loan', false),
  ('payroll_loan', 'decide',   'loan', false),
  ('payroll_loan', 'disburse', 'loan', false),
  ('payroll_loan', 'recover',  'loan', false),
  ('own_loan',     'read',     'loan', true),
  ('own_loan',     'request',  'loan', true);
