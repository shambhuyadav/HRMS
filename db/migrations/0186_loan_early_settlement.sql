-- 0186 Loan early settlement (FR-034 "Define interest and early-settlement rules if required"; DF07; C4; TN15). Decided under owner
-- delegation, 6 Nov 2026 (docs/03 I-81 item 1); a later migration can reverse it.
--
-- An early settlement closes a disbursed loan in full: the balance left after the recoveries recognised from processed payroll is
-- either repaid by the employee (outside payroll, evidenced by one released, verified document, or recovered through the
-- employee's paid full-and-final settlement) or waived or written off by the company, or a mix of the two. The amounts are entered
-- by the person recording it and approved by someone else; nothing computes them. The terms and the approved schedule never change
-- (TN15 "no schedule edits"), so there is no partial prepayment. A waiver or write-off needs the decider to hold the separate
-- `payroll_loan.waive.loan` grant, which no role holds by default. The loan closes only through an approved settlement, in the
-- database: settled and waived amounts are written by this table's trigger alone, and a closed loan's recoveries, repayment and
-- waiver add up to its principal.

alter table payroll_loan
  add column settled_amount numeric(19, 4) not null default 0 check (settled_amount >= 0),
  add column waived_amount numeric(19, 4) not null default 0 check (waived_amount >= 0);

do $$
declare
  c record;
  dropped integer := 0;
begin
  for c in select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'payroll_loan'::regclass and contype = 'c' loop
    if c.def = 'CHECK ((recovered_amount <= principal))' or c.def = 'CHECK (((state <> ''CLOSED''::text) OR (recovered_amount = principal)))' then
      execute format('alter table payroll_loan drop constraint %I', c.conname);
      dropped := dropped + 1;
    end if;
  end loop;
  if dropped <> 2 then
    raise exception 'expected the two loan balance checks, found %', dropped;
  end if;
end $$;
alter table payroll_loan add constraint payroll_loan_balance_within_principal check (recovered_amount + settled_amount + waived_amount <= principal);
alter table payroll_loan add constraint payroll_loan_closed_in_full check (state <> 'CLOSED' or recovered_amount + settled_amount + waived_amount = principal);
alter table payroll_loan add constraint payroll_loan_settled_only_closed check (settled_amount + waived_amount = 0 or state = 'CLOSED');

create table payroll_loan_settlement (
  id                       uuid primary key default gen_random_uuid(),
  company_id               uuid not null references company (id) on delete restrict,
  loan_id                  uuid not null,
  employee_id              uuid not null,
  currency_code            text not null check (currency_code ~ '^[A-Z]{3}$'),
  -- The balance left when it was recorded (principal less recognised recoveries); the parts below add up to it.
  balance                  numeric(19, 4) not null check (balance > 0),
  repaid_amount            numeric(19, 4) not null check (repaid_amount >= 0),
  repayment_route          text check (repayment_route in ('DIRECT_REPAYMENT', 'FINAL_SETTLEMENT')),
  repayment_date           date,
  evidence_key             text check (evidence_key is null or evidence_key ~ '^[A-Za-z0-9._:-]{8,100}$'),
  evidence_reference       text check (evidence_reference is null or (btrim(evidence_reference) <> '' and length(evidence_reference) <= 500)),
  evidence_document_id     uuid,
  settlement_id            uuid,
  waived_amount            numeric(19, 4) not null check (waived_amount >= 0),
  waiver_kind              text check (waiver_kind in ('WAIVER', 'WRITE_OFF')),
  reason                   text not null check (btrim(reason) <> '' and length(reason) <= 1000),
  state                    text not null check (state in ('PROPOSED', 'APPROVED', 'REJECTED')),
  recorded_by              uuid not null references user_account (id) on delete restrict,
  recorded_assignment_id   uuid not null,
  recorded_at              timestamptz not null default now(),
  decided_by               uuid references user_account (id) on delete restrict,
  decided_assignment_id    uuid,
  decided_at               timestamptz,
  decision_reason          text check (decision_reason is null or (btrim(decision_reason) <> '' and length(decision_reason) <= 1000)),
  created_at               timestamptz not null default now(),
  created_by               uuid not null references user_account (id) on delete restrict,
  updated_at               timestamptz not null default now(),
  updated_by               uuid references user_account (id) on delete restrict,
  version                  integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, evidence_key),
  foreign key (company_id, loan_id, employee_id) references payroll_loan (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, evidence_document_id) references employee_document (company_id, id) on delete restrict,
  foreign key (company_id, settlement_id, employee_id) references settlement (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, recorded_assignment_id) references role_assignment (company_id, id) on delete restrict,
  foreign key (company_id, decided_assignment_id) references role_assignment (company_id, id) on delete restrict,
  check (repaid_amount + waived_amount = balance),
  check ((repaid_amount > 0) = (repayment_route is not null)),
  check ((repaid_amount > 0) = (repayment_date is not null)),
  check ((waived_amount > 0) = (waiver_kind is not null)),
  -- A direct repayment is evidenced by its key, reference and document; a recovery through the final settlement by that settlement.
  check ((repayment_route = 'DIRECT_REPAYMENT') = (evidence_document_id is not null)
         and (repayment_route = 'DIRECT_REPAYMENT') = (evidence_key is not null)
         and (repayment_route = 'DIRECT_REPAYMENT') = (evidence_reference is not null)),
  check ((repayment_route = 'FINAL_SETTLEMENT') = (settlement_id is not null)),
  check ((state = 'PROPOSED') = (decided_at is null)),
  check ((decided_at is null) = (decided_by is null) and (decided_at is null) = (decided_assignment_id is null)),
  check (state <> 'REJECTED' or decision_reason is not null),
  -- C4: whoever recorded it never decides it.
  check (decided_by is null or decided_by <> recorded_by),
  check (created_by = recorded_by)
);
create index payroll_loan_settlement_loan_idx on payroll_loan_settlement (company_id, loan_id);
-- One settlement waiting per loan, and at most one ever approved (it closes the loan).
create unique index payroll_loan_settlement_one_open on payroll_loan_settlement (company_id, loan_id) where (state = 'PROPOSED');
create unique index payroll_loan_settlement_one_approved on payroll_loan_settlement (company_id, loan_id) where (state = 'APPROVED');

create function hrms_payroll_loan_settlement_guard() returns trigger language plpgsql as $$
declare
  l payroll_loan%rowtype;
begin
  if tg_op = 'INSERT' then
    if new.state <> 'PROPOSED' or new.decided_at is not null then
      raise exception 'a loan settlement starts as a proposal' using errcode = '23514';
    end if;
    select * into l from payroll_loan where company_id = new.company_id and id = new.loan_id;
    if l.state <> 'DISBURSED' or new.currency_code <> l.currency_code or new.balance <> l.principal - l.recovered_amount then
      raise exception 'a loan settlement settles the whole balance of a disbursed loan in its currency' using errcode = '23514';
    end if;
    return new;
  end if;
  if (new.loan_id, new.employee_id, new.currency_code, new.balance, new.repaid_amount, new.repayment_route, new.repayment_date, new.evidence_key, new.evidence_reference,
      new.evidence_document_id, new.settlement_id, new.waived_amount, new.waiver_kind, new.reason, new.recorded_by, new.recorded_assignment_id, new.recorded_at, new.created_by)
     is distinct from
     (old.loan_id, old.employee_id, old.currency_code, old.balance, old.repaid_amount, old.repayment_route, old.repayment_date, old.evidence_key, old.evidence_reference,
      old.evidence_document_id, old.settlement_id, old.waived_amount, old.waiver_kind, old.reason, old.recorded_by, old.recorded_assignment_id, old.recorded_at, old.created_by) then
    raise exception 'a recorded loan settlement never changes' using errcode = '23514';
  end if;
  if old.state <> 'PROPOSED' and (new.state, new.decided_by, new.decided_assignment_id, new.decided_at, new.decision_reason)
     is distinct from (old.state, old.decided_by, old.decided_assignment_id, old.decided_at, old.decision_reason) then
    raise exception 'a loan settlement is decided once' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger payroll_loan_settlement_guard before insert or update on payroll_loan_settlement for each row execute function hrms_payroll_loan_settlement_guard();

-- The approval closes the loan, here only: the balance must still be what was recorded.
create function hrms_payroll_loan_settlement_apply() returns trigger language plpgsql as $$
declare
  l payroll_loan%rowtype;
begin
  if new.state = 'APPROVED' and old.state = 'PROPOSED' then
    select * into l from payroll_loan where company_id = new.company_id and id = new.loan_id for update;
    if l.state <> 'DISBURSED' or l.principal - l.recovered_amount <> new.balance then
      raise exception 'the loan balance changed after the settlement was recorded' using errcode = '23514';
    end if;
    update payroll_loan
       set settled_amount = new.repaid_amount, waived_amount = new.waived_amount, state = 'CLOSED', closed_at = now(), closed_by = new.decided_by,
           close_reason = case when new.waived_amount = 0 then 'Settled early' when new.repaid_amount = 0 then 'Balance waived or written off' else 'Settled early, rest waived or written off' end,
           updated_by = new.decided_by
     where company_id = new.company_id and id = new.loan_id;
  end if;
  return new;
end $$;
create trigger payroll_loan_settlement_apply after update on payroll_loan_settlement for each row execute function hrms_payroll_loan_settlement_apply();
create trigger payroll_loan_settlement_touch before update on payroll_loan_settlement for each row execute function hrms_touch();
create trigger payroll_loan_settlement_no_delete before delete on payroll_loan_settlement for each row execute function hrms_no_delete();

-- The loan guard of 0046, with the settled and waived amounts written only by the settlement trigger above.
create or replace function hrms_payroll_loan_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.state <> 'REQUESTED' or new.decided_at is not null or new.disbursed_at is not null or new.recovered_amount <> 0 or new.recovery_component_id is not null
       or new.settled_amount <> 0 or new.waived_amount <> 0 then
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
  if (new.settled_amount, new.waived_amount) is distinct from (old.settled_amount, old.waived_amount)
     and (pg_trigger_depth() < 2 or old.settled_amount <> 0 or old.waived_amount <> 0) then
    raise exception 'settled and waived amounts are written once, by an approved loan settlement' using errcode = '23514';
  end if;
  if new.state is distinct from old.state and not (
       (old.state = 'REQUESTED' and new.state in ('APPROVED', 'REJECTED', 'WITHDRAWN'))
    or (old.state = 'APPROVED' and new.state in ('DISBURSED', 'CANCELLED'))
    or (old.state = 'DISBURSED' and new.state = 'CLOSED')) then
    raise exception 'invalid loan transition % -> %', old.state, new.state using errcode = '23514';
  end if;
  return new;
end $$;

-- Waiving or writing off a balance is a right of its own (FR-002), held by no role by default: a company that forgives loans
-- grants it, per assignment and independently approved, to the approvers it chooses (access administration).
insert into permission (resource, action, field_group, own_ess) values ('payroll_loan', 'waive', 'loan', false);
