-- 0214 An arrear or a late-timesheet adjustment paid by a final settlement (FR-035, FR-052, FR-100; DB111; I-79; I-88 follow-up). Decided
-- under owner delegation, 6 Nov 2026 (docs/03 I-88): a case the final settlement's calculation took (settlement_calculation_item, 0235;
-- calculate.ts SETTLEMENT_TAKES keeps payroll from taking it) stays APPROVED while that settlement is in progress. When the settlement is
-- recorded as paid, the case becomes APPLIED naming the settlement (applied_settlement_id), as processing names the record or the run
-- and line that paid it. A settlement cancelled, returned or rejected before payment leaves the case free for a later payroll. A case is
-- applied once, by a payroll record or by a settlement, never both.
alter table payroll_arrears_case add column applied_settlement_id uuid;
alter table payroll_arrears_case add constraint payroll_arrears_case_applied_settlement_fk
  foreign key (company_id, applied_settlement_id, employee_id) references settlement (company_id, id, employee_id) on delete restrict;
alter table payroll_arrears_case drop constraint payroll_arrears_case_applied;
alter table payroll_arrears_case add constraint payroll_arrears_case_applied check (
  (state = 'APPLIED') = (applied_record_id is not null or applied_settlement_id is not null)
  and not (applied_record_id is not null and applied_settlement_id is not null));
create index payroll_arrears_case_settlement_idx on payroll_arrears_case (company_id, applied_settlement_id) where (applied_settlement_id is not null);

alter table payroll_adjustment add column applied_settlement_id uuid;
alter table payroll_adjustment add constraint payroll_adjustment_applied_settlement_fk
  foreign key (company_id, applied_settlement_id, employee_id) references settlement (company_id, id, employee_id) on delete restrict;
-- 0129's "applied has one line" and "applied has a target run" become: applied by a payroll line in a target run, or by a settlement.
do $$
declare
  c record;
  dropped integer := 0;
begin
  for c in select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'payroll_adjustment'::regclass and contype = 'c' loop
    if c.def like '%(state = ''APPLIED''::text) = (applied_payroll_line_id IS NOT NULL)%' or c.def like '%(state <> ''APPLIED''::text) OR (target_run_id IS NOT NULL)%' then
      execute format('alter table payroll_adjustment drop constraint %I', c.conname);
      dropped := dropped + 1;
    end if;
  end loop;
  if dropped <> 2 then
    raise exception 'expected the two applied checks of payroll_adjustment, found %', dropped;
  end if;
end $$;
alter table payroll_adjustment add constraint payroll_adjustment_applied check (
  (state = 'APPLIED') = (applied_payroll_line_id is not null or applied_settlement_id is not null)
  and not (applied_payroll_line_id is not null and applied_settlement_id is not null)
  and (applied_payroll_line_id is null) = (target_run_id is null));
create index payroll_adjustment_settlement_idx on payroll_adjustment (company_id, applied_settlement_id) where (applied_settlement_id is not null);

-- A settlement pays a case when it is paid and its calculation took the case (a calculated item naming it). plpgsql on purpose: the
-- settlement calculation (0235) is created after this migration in file order, and a plpgsql body names its tables only when it runs.
create function hrms_settlement_paid_case(p_company uuid, p_settlement uuid, p_employee uuid, p_column text, p_case uuid) returns boolean
language plpgsql stable as $$
begin
  return exists (
    select 1 from settlement s
      join settlement_calculation_item i on i.company_id = s.company_id and i.calculation_id = s.calculation_id and i.status = 'CALCULATED'
     where s.company_id = p_company and s.id = p_settlement and s.employee_id = p_employee and s.state = 'PAID'
       and ((p_column = 'arrears_case_id' and i.arrears_case_id = p_case) or (p_column = 'adjustment_id' and i.adjustment_id = p_case)));
end $$;

create or replace function hrms_payroll_arrears_guard() returns trigger language plpgsql as $$
declare
  ru record;
  sa record;
begin
  if tg_op = 'INSERT' then
    if new.state <> 'SUBMITTED' or new.applied_record_id is not null or new.applied_settlement_id is not null then
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
  -- Application: an approved case is paid once, by the processing of a later record of its employee or by its paid final settlement.
  if old.state = 'APPROVED' and new.state = 'APPLIED' then
    if old.applied_record_id is not null or old.applied_settlement_id is not null or (new.decided_at, new.decided_by) is distinct from (old.decided_at, old.decided_by) then
      raise exception 'an arrears case is applied once' using errcode = '23514';
    end if;
    if new.applied_settlement_id is not null then
      if not hrms_settlement_paid_case(new.company_id, new.applied_settlement_id, new.employee_id, 'arrears_case_id', new.id) then
        raise exception 'an arrears case is applied by the paid final settlement whose calculation took it' using errcode = '23514';
      end if;
      return new;
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
  if old.state <> 'SUBMITTED' or new.applied_record_id is not null or new.applied_settlement_id is not null then
    raise exception 'the decision on an arrears case is final' using errcode = '23514';
  end if;
  return new;
end $$;

create or replace function hrms_payroll_adjustment_guard() returns trigger language plpgsql as $$
declare
  rev record;
  ts record;
  ru record;
begin
  if tg_op = 'INSERT' then
    if new.state <> 'DRAFT' or new.target_run_id is not null or new.applied_payroll_line_id is not null or new.applied_settlement_id is not null then
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
  if old.state <> 'DRAFT' and (new.previous_recognized_units, new.corrected_units, new.delta_amount, new.explanation, new.valuation_policy_id)
     is distinct from (old.previous_recognized_units, old.corrected_units, old.delta_amount, old.explanation, old.valuation_policy_id) then
    raise exception 'a submitted payroll adjustment is immutable' using errcode = '23514';
  end if;
  if new.state <> old.state and not ((old.state = 'DRAFT' and new.state = 'SUBMITTED')
                                     or (old.state = 'SUBMITTED' and new.state in ('APPROVED', 'RETURNED', 'REJECTED'))
                                     or (old.state = 'APPROVED' and new.state in ('APPLIED', 'VOID'))) then
    raise exception 'payroll adjustment state % cannot become %', old.state, new.state using errcode = '23514';
  end if;
  -- Application (FR-100): the processing of a later payroll of the employee names its run and the record's line, once; or the paid
  -- final settlement whose calculation took the case names itself.
  if old.state = 'APPROVED' and new.state = 'APPLIED' then
    if old.target_run_id is not null or old.applied_payroll_line_id is not null or old.applied_settlement_id is not null
       or (new.decided_at, new.decided_by) is distinct from (old.decided_at, old.decided_by) then
      raise exception 'a payroll adjustment is applied once' using errcode = '23514';
    end if;
    if new.applied_settlement_id is not null then
      if not hrms_settlement_paid_case(new.company_id, new.applied_settlement_id, new.employee_id, 'adjustment_id', new.id) then
        raise exception 'a payroll adjustment is applied by the paid final settlement whose calculation took it' using errcode = '23514';
      end if;
      return new;
    end if;
    -- The aliases are not "ru", "rev" or "ts": those names are this function's record variables, which plpgsql would read instead.
    if not exists (select 1 from payroll_line pl
                     join payroll_record tr on tr.company_id = pl.company_id and tr.id = pl.record_id
                     join payroll_run tu on tu.company_id = tr.company_id and tu.id = tr.run_id
                     join payroll_run ou on ou.company_id = new.company_id and ou.id = new.origin_run_id
                    where pl.company_id = new.company_id and pl.id = new.applied_payroll_line_id and tr.employee_id = new.employee_id
                      and tu.id = new.target_run_id and tu.processing_started_at is not null and tu.service_start > ou.service_start) then
      raise exception 'a payroll adjustment is applied by the processing of a later payroll record of its employee' using errcode = '23514';
    end if;
    return new;
  end if;
  if (new.target_run_id, new.applied_payroll_line_id, new.applied_settlement_id) is distinct from (old.target_run_id, old.applied_payroll_line_id, old.applied_settlement_id) then
    raise exception 'the target of a payroll adjustment is set when it is applied' using errcode = '23514';
  end if;
  return new;
end $$;
