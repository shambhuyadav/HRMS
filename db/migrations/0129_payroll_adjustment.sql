-- 0129 DB111 payroll_adjustment: late or amended timesheet cases held pending (FR-100; H2 late-timesheet journey and
-- "Timesheet adjustment" states; H4 "Adjustment case"; H5 DB111; BR-047; BR-048; BR-049; CI25; CI26; ZT37).
--
-- A case records that an approved timesheet revision came after the freeze of a processed payroll covering its service dates,
-- with its source, its origin and an independent review. Nothing values it and nothing consumes it: the calculation never reads
-- this table, no code sets target_run_id or applied_payroll_line_id, and no case can reach APPROVED until a later change brings
-- the adjustment valuation policy BR-048 names (H2: "An unresolved policy/rate/currency question blocks adjustment approval").
-- Units and the signed difference, when entered at all, are a person's entry on the draft; they are never computed.
--
-- H2 states: DRAFT -> SUBMITTED -> APPROVED -> APPLIED; RETURNED and REJECTED end the case and need a new request (which links
-- back); VOID before application, with approval. APPROVED, APPLIED and VOID have no route yet; the constraints that hold them
-- stand, so those states can only ever mean what H2 and DB111 say.
create table payroll_adjustment (
  id                         uuid primary key default gen_random_uuid(),
  company_id                 uuid not null references company (id) on delete restrict,
  employee_id                uuid not null,
  source_timesheet_id        uuid not null,
  source_revision            integer not null,
  origin_payroll_record_id   uuid not null,
  origin_run_id              uuid not null,
  target_run_id              uuid,
  transaction_kind           text not null default 'timesheet_adjustment' check (transaction_kind = 'timesheet_adjustment'),
  transaction_id             uuid not null,
  applied_payroll_line_id    uuid,
  -- FR-100 "late or amended": an amended case comes from a reopened revision.
  adjustment_kind            text not null check (adjustment_kind in ('LATE_TIMESHEET', 'AMENDED_TIMESHEET')),
  previous_recognized_units  numeric(9, 4) check (previous_recognized_units >= 0),
  corrected_units            numeric(9, 4) check (corrected_units >= 0),
  -- MONEY signed (H4 "positive/negative sign retained"); optional until approval.
  delta_amount               numeric(19, 4),
  currency_code              text not null check (currency_code ~ '^[A-Z]{3}$'),
  -- DB111 rule_snapshot: which frozen run, period and paid-day policy the origin was calculated under (references only).
  rule_snapshot              jsonb not null check (jsonb_typeof(rule_snapshot) = 'object'),
  explanation                text check (explanation is null or (btrim(explanation) <> '' and length(explanation) <= 2000)),
  state                      text not null default 'DRAFT' check (state in ('DRAFT', 'SUBMITTED', 'APPROVED', 'APPLIED', 'RETURNED', 'REJECTED', 'VOID')),
  -- The returned or rejected case of the same source and origin this one continues.
  follows_adjustment_id      uuid,
  submitted_at               timestamptz,
  decided_at                 timestamptz,
  decided_by                 uuid references user_account (id) on delete restrict,
  created_at                 timestamptz not null default now(),
  created_by                 uuid references user_account (id) on delete restrict,
  updated_at                 timestamptz not null default now(),
  updated_by                 uuid references user_account (id) on delete restrict,
  version                    integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, id, employee_id),
  -- DB111 "transaction unique".
  unique (company_id, transaction_id),
  -- CI26 "same employee/company": the source and the origin are the employee's own, by key.
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict,
  foreign key (company_id, source_timesheet_id, employee_id) references timesheet (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, source_timesheet_id, source_revision) references timesheet_revision (company_id, timesheet_id, revision) on delete restrict,
  foreign key (company_id, origin_payroll_record_id, employee_id) references payroll_record (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, origin_payroll_record_id, origin_run_id) references payroll_record (company_id, id, run_id) on delete restrict,
  foreign key (company_id, target_run_id) references payroll_run (company_id, id) on delete restrict,
  foreign key (company_id, applied_payroll_line_id) references payroll_line (company_id, id) on delete restrict,
  foreign key (company_id, transaction_kind, transaction_id) references business_transaction (company_id, kind, id)
    on delete restrict deferrable initially deferred,
  foreign key (company_id, follows_adjustment_id, employee_id) references payroll_adjustment (company_id, id, employee_id) on delete restrict,
  check (follows_adjustment_id is null or follows_adjustment_id <> id),
  -- CI25: a correction references the original and never targets it.
  check (target_run_id is null or target_run_id <> origin_run_id),
  check ((state = 'DRAFT') = (submitted_at is null)),
  check (state = 'DRAFT' or explanation is not null),
  check ((decided_at is null) = (decided_by is null)),
  check ((state in ('APPROVED', 'APPLIED', 'RETURNED', 'REJECTED', 'VOID')) = (decided_at is not null)),
  -- H4: an approved case states its units and signed difference.
  check (state not in ('APPROVED', 'APPLIED') or (previous_recognized_units is not null and corrected_units is not null and delta_amount is not null)),
  -- DB111: an applied case has exactly one target line in one target run.
  check ((state = 'APPLIED') = (applied_payroll_line_id is not null)),
  check (state <> 'APPLIED' or target_run_id is not null)
);
-- DB111 "Unique effective source revision/origin/adjustment kind" (BR-048 "Every source revision is uniquely linked").
create unique index payroll_adjustment_one_effective on payroll_adjustment (company_id, source_timesheet_id, source_revision, origin_payroll_record_id, adjustment_kind)
  where (state in ('DRAFT', 'SUBMITTED', 'APPROVED', 'APPLIED'));
create unique index payroll_adjustment_one_applied_line on payroll_adjustment (company_id, applied_payroll_line_id) where (applied_payroll_line_id is not null);
create unique index payroll_adjustment_one_successor on payroll_adjustment (company_id, follows_adjustment_id) where (follows_adjustment_id is not null);
create index payroll_adjustment_employee_idx on payroll_adjustment (company_id, employee_id, created_at desc);
create index payroll_adjustment_state_idx on payroll_adjustment (company_id, state, created_at desc);

create function hrms_payroll_adjustment_guard() returns trigger language plpgsql as $$
declare
  rev record;
  ts record;
  ru record;
begin
  if tg_op = 'INSERT' then
    if new.state <> 'DRAFT' or new.target_run_id is not null or new.applied_payroll_line_id is not null then
      raise exception 'a payroll adjustment starts as a draft with no target' using errcode = '23514';
    end if;
    select state, decided_at, superseded_at into rev from timesheet_revision where company_id = new.company_id and timesheet_id = new.source_timesheet_id and revision = new.source_revision;
    if rev.state is distinct from 'APPROVED' or rev.superseded_at is not null then
      raise exception 'an adjustment comes from the approved timesheet revision in force' using errcode = '23514';
    end if;
    select state, processed_at, service_start, service_end into ru from payroll_run where company_id = new.company_id and id = new.origin_run_id;
    if ru.state is distinct from 'PROCESSED_LOCKED' then
      raise exception 'an adjustment originates in a processed payroll' using errcode = '23514';
    end if;
    select period_start, period_end into ts from timesheet where company_id = new.company_id and id = new.source_timesheet_id;
    -- CI26 "same origin period".
    if ts.period_end < ru.service_start or ts.period_start > ru.service_end then
      raise exception 'the timesheet service dates are outside the origin period' using errcode = '23514';
    end if;
    -- FR-100 "affecting a processed payroll": approved after that payroll froze.
    if rev.decided_at <= ru.processed_at then
      raise exception 'the timesheet revision was approved before the origin payroll was processed' using errcode = '23514';
    end if;
    return new;
  end if;
  if (new.employee_id, new.source_timesheet_id, new.source_revision, new.origin_payroll_record_id, new.origin_run_id, new.transaction_id,
      new.adjustment_kind, new.currency_code, new.rule_snapshot, new.follows_adjustment_id)
     is distinct from
     (old.employee_id, old.source_timesheet_id, old.source_revision, old.origin_payroll_record_id, old.origin_run_id, old.transaction_id,
      old.adjustment_kind, old.currency_code, old.rule_snapshot, old.follows_adjustment_id) then
    raise exception 'the source and origin of a payroll adjustment are fixed' using errcode = '23514';
  end if;
  if old.state <> 'DRAFT' and (new.previous_recognized_units, new.corrected_units, new.delta_amount, new.explanation)
     is distinct from (old.previous_recognized_units, old.corrected_units, old.delta_amount, old.explanation) then
    raise exception 'a submitted payroll adjustment is immutable' using errcode = '23514';
  end if;
  if new.state <> old.state and not ((old.state = 'DRAFT' and new.state = 'SUBMITTED')
                                     or (old.state = 'SUBMITTED' and new.state in ('APPROVED', 'RETURNED', 'REJECTED'))
                                     or (old.state = 'APPROVED' and new.state in ('APPLIED', 'VOID'))) then
    raise exception 'payroll adjustment state % cannot become %', old.state, new.state using errcode = '23514';
  end if;
  return new;
end $$;
create trigger payroll_adjustment_guard before insert or update on payroll_adjustment for each row execute function hrms_payroll_adjustment_guard();
create trigger payroll_adjustment_touch before update on payroll_adjustment for each row execute function hrms_touch();
create trigger payroll_adjustment_no_delete before delete on payroll_adjustment for each row execute function hrms_no_delete();
create constraint trigger payroll_adjustment_mirrors_transaction after insert or update on payroll_adjustment
  deferrable initially deferred for each row execute function hrms_payroll_mirror();

-- H5: "Typed root additions ... TIMESHEET_ADJUSTMENT extend business_transaction.kind".
insert into transaction_kind (kind, root_table, routing_kind) values ('timesheet_adjustment', 'payroll_adjustment', null);
insert into transaction_state (kind, state, initial, terminal) values
  ('timesheet_adjustment', 'DRAFT',     true,  false),
  ('timesheet_adjustment', 'SUBMITTED', false, false),
  ('timesheet_adjustment', 'APPROVED',  false, false),
  ('timesheet_adjustment', 'APPLIED',   false, true),
  ('timesheet_adjustment', 'RETURNED',  false, true),
  ('timesheet_adjustment', 'REJECTED',  false, true),
  ('timesheet_adjustment', 'VOID',      false, true);
insert into transaction_transition (kind, from_state, to_state) values
  ('timesheet_adjustment', 'DRAFT',     'SUBMITTED'),
  ('timesheet_adjustment', 'SUBMITTED', 'APPROVED'),
  ('timesheet_adjustment', 'SUBMITTED', 'RETURNED'),
  ('timesheet_adjustment', 'SUBMITTED', 'REJECTED'),
  ('timesheet_adjustment', 'APPROVED',  'APPLIED'),
  ('timesheet_adjustment', 'APPROVED',  'VOID');

-- Payroll amounts: confidential, ceiling-only grants of the HR Administrator role (DF02; I-28).
insert into permission (resource, action, field_group, own_ess) values
  ('payroll_adjustment', 'read',    'amount', false),
  ('payroll_adjustment', 'propose', 'amount', false),
  ('payroll_adjustment', 'decide',  'amount', false);
