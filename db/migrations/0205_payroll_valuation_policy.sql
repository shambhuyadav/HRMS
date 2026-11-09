-- 0205 Arrears and late-timesheet adjustments reach payroll (FR-035, FR-100; DF05; DF15; H2; BR-047; BR-048; CI25; ZT16). Decided
-- under owner delegation, 6 Nov 2026 (docs/03 I-79): the valuation rules are company settings, dated and activated by someone other
-- than their author, never constants.
--
-- 1. payroll_valuation_policy names the pay components an approved arrear or adjustment is paid through (an EARNING head) and
--    recovered through (a DEDUCTION head; none means a negative case cannot be approved, H2), and what one timesheet unit is worth
--    (a day of the origin month, or an hour of such a day). The amounts themselves follow DF05 and are computed in the services.
-- 2. payroll_record_input also holds the approved arrears cases and adjustments a later calculation picked up (source_kind), so the
--    lines, totals and rerun check treat them as they treat approved inputs, each once.
-- 3. An arrears case reaches APPLIED, naming the processed record that paid it, once.
-- Nothing stored is read or changed beyond widening two checks, so this cannot stop an upgrade.

create table payroll_valuation_policy (
  id                       uuid primary key default gen_random_uuid(),
  company_id               uuid not null references company (id) on delete restrict,
  revision                 integer not null check (revision > 0),
  effective_from           date not null,
  arrears_component_id     uuid not null,
  adjustment_component_id  uuid not null,
  recovery_component_id    uuid,
  timesheet_unit           text not null check (timesheet_unit in ('DAY', 'HOUR')),
  hours_per_day            numeric(4, 2) check (hours_per_day > 0 and hours_per_day <= 24),
  state                    text not null check (state in ('DRAFT', 'ACTIVE', 'SUPERSEDED', 'CANCELLED')),
  activated_by             uuid references user_account (id) on delete restrict,
  activated_at             timestamptz,
  created_at               timestamptz not null default now(),
  created_by               uuid references user_account (id) on delete restrict,
  updated_at               timestamptz not null default now(),
  updated_by               uuid references user_account (id) on delete restrict,
  version                  integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, revision),
  foreign key (company_id, arrears_component_id) references pay_component (company_id, id) on delete restrict,
  foreign key (company_id, adjustment_component_id) references pay_component (company_id, id) on delete restrict,
  foreign key (company_id, recovery_component_id) references pay_component (company_id, id) on delete restrict,
  check ((timesheet_unit = 'HOUR') = (hours_per_day is not null)),
  check (state in ('DRAFT', 'CANCELLED') or (activated_by is not null and activated_at is not null)),
  check (activated_by is null or created_by is null or activated_by <> created_by)
);
create unique index payroll_valuation_one_active_start on payroll_valuation_policy (company_id, effective_from) where (state = 'ACTIVE');

create function hrms_payroll_valuation_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.state <> 'DRAFT' then
      raise exception 'a valuation policy starts as a draft' using errcode = '23514';
    end if;
    if new.revision <> coalesce((select max(revision) from payroll_valuation_policy where company_id = new.company_id), 0) + 1 then
      raise exception 'valuation policy revisions are consecutive' using errcode = '23514';
    end if;
    return new;
  end if;
  if (new.revision, new.effective_from, new.arrears_component_id, new.adjustment_component_id, new.recovery_component_id, new.timesheet_unit, new.hours_per_day)
     is distinct from
     (old.revision, old.effective_from, old.arrears_component_id, old.adjustment_component_id, old.recovery_component_id, old.timesheet_unit, old.hours_per_day) then
    raise exception 'a valuation policy revision is fixed once created' using errcode = '23514';
  end if;
  if old.state <> 'DRAFT' and (new.activated_by, new.activated_at) is distinct from (old.activated_by, old.activated_at) then
    raise exception 'the activation of a valuation policy is final' using errcode = '23514';
  end if;
  if new.state <> old.state and not ((old.state = 'DRAFT' and new.state in ('ACTIVE', 'CANCELLED')) or (old.state = 'ACTIVE' and new.state = 'SUPERSEDED')) then
    raise exception 'valuation policy state % cannot become %', old.state, new.state using errcode = '23514';
  end if;
  return new;
end $$;
create trigger payroll_valuation_policy_guard before insert or update on payroll_valuation_policy for each row execute function hrms_payroll_valuation_guard();
create trigger payroll_valuation_policy_touch before update on payroll_valuation_policy for each row execute function hrms_touch();
create trigger payroll_valuation_policy_no_delete before delete on payroll_valuation_policy for each row execute function hrms_no_delete();

-- 2. The snapshot of a later record holds an approved case once, on the policy's component, as a positive amount.
alter table payroll_record_input drop constraint payroll_record_input_source_kind_check;
alter table payroll_record_input add constraint payroll_record_input_source_kind_check check (source_kind in ('INPUT', 'ARREARS', 'ADJUSTMENT'));
alter table payroll_record_input alter column input_id drop not null;
alter table payroll_record_input add column arrears_case_id uuid, add column adjustment_id uuid;
alter table payroll_record_input add constraint payroll_record_input_arrears_fk
  foreign key (company_id, arrears_case_id, employee_id) references payroll_arrears_case (company_id, id, employee_id) on delete restrict;
alter table payroll_record_input add constraint payroll_record_input_adjustment_fk
  foreign key (company_id, adjustment_id, employee_id) references payroll_adjustment (company_id, id, employee_id) on delete restrict;
alter table payroll_record_input add constraint payroll_record_input_one_source check (
  (source_kind = 'INPUT') = (input_id is not null)
  and (source_kind = 'ARREARS') = (arrears_case_id is not null)
  and (source_kind = 'ADJUSTMENT') = (adjustment_id is not null));
create unique index payroll_record_input_one_arrears on payroll_record_input (company_id, record_id, arrears_case_id) where (arrears_case_id is not null);
create unique index payroll_record_input_one_adjustment on payroll_record_input (company_id, record_id, adjustment_id) where (adjustment_id is not null);
create index payroll_record_input_arrears_idx on payroll_record_input (company_id, arrears_case_id) where (arrears_case_id is not null);
create index payroll_record_input_adjustment_idx on payroll_record_input (company_id, adjustment_id) where (adjustment_id is not null);

-- 3. APPROVED -> APPLIED, by the processing of the record that paid it, once.
alter table payroll_arrears_case drop constraint payroll_arrears_case_state_check;
alter table payroll_arrears_case add constraint payroll_arrears_case_state_check check (state in ('SUBMITTED', 'APPROVED', 'APPLIED', 'RETURNED', 'REJECTED'));
alter table payroll_arrears_case add column applied_record_id uuid;
alter table payroll_arrears_case add constraint payroll_arrears_case_applied_fk
  foreign key (company_id, applied_record_id, employee_id) references payroll_record (company_id, id, employee_id) on delete restrict;
alter table payroll_arrears_case add constraint payroll_arrears_case_applied check ((state = 'APPLIED') = (applied_record_id is not null));
-- FR-035 "rerunning the same revision does not pay the same arrears twice": a paid case keeps its key, as a live one does.
drop index payroll_arrears_one_live;
create unique index payroll_arrears_one_live on payroll_arrears_case (company_id, employee_id, source_arrangement_id, origin_period_id)
  where (state in ('SUBMITTED', 'APPROVED', 'APPLIED'));

create or replace function hrms_payroll_arrears_guard() returns trigger language plpgsql as $$
declare
  ru record;
  sa record;
begin
  if tg_op = 'INSERT' then
    if new.state <> 'SUBMITTED' or new.applied_record_id is not null then
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
  -- Application: an approved case is paid once, by the processing of a later record of its employee, and nothing else changes.
  if old.state = 'APPROVED' and new.state = 'APPLIED' then
    if old.applied_record_id is not null or (new.decided_at, new.decided_by) is distinct from (old.decided_at, old.decided_by) then
      raise exception 'an arrears case is applied once' using errcode = '23514';
    end if;
    -- The run alias is not "ru": that name is this function's record variable, and plpgsql would read the alias as it.
    if not exists (select 1 from payroll_record r join payroll_run later on later.company_id = r.company_id and later.id = r.run_id
                    where r.company_id = new.company_id and r.id = new.applied_record_id and r.employee_id = new.employee_id
                      and later.processing_started_at is not null
                      and later.service_start > (select service_start from payroll_period where company_id = new.company_id and id = new.origin_period_id)) then
      raise exception 'an arrears case is applied by the processing of a later payroll record' using errcode = '23514';
    end if;
    return new;
  end if;
  if old.state <> 'SUBMITTED' or new.applied_record_id is not null then
    raise exception 'the decision on an arrears case is final' using errcode = '23514';
  end if;
  return new;
end $$;

update transaction_state set terminal = false where kind = 'payroll_arrears_case' and state = 'APPROVED';
insert into transaction_state (kind, state, initial, terminal) values ('payroll_arrears_case', 'APPLIED', false, true);
insert into transaction_transition (kind, from_state, to_state) values ('payroll_arrears_case', 'APPROVED', 'APPLIED');
