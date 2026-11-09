-- 0206 Late-timesheet adjustments are valued and paid (FR-100; DB111; H2 late-timesheet journey; H4; BR-047; BR-048; BR-049; CI25;
-- CI26; ZT37). Decided under owner delegation, 6 Nov 2026 (docs/03 I-79), on the valuation policy of 0205.
--
-- 1. A case is valued under the valuation policy in effect when it is opened, changed or submitted (BR-048 "the current applicable
--    adjustment valuation policy"): the corrected eligible units of the approved revision against the units the frozen origin record
--    recognised (H2), on the origin record's own rates (BR-048 "original service-period rate/rule/calendar snapshots"). The policy it
--    was valued under is recorded with its figures and is fixed once the case is submitted. An approved case was valued, under a
--    policy, to a difference that is not zero.
-- 2. The first later payroll of the employee in the same currency pays it once (FR-100 acceptance) on the policy's adjustment
--    component: processing names the target run and the record's line for that component and marks the case APPLIED, and nothing
--    else changes on it. The origin run is never the target (CI25). Several cases of one record are paid on the same component line,
--    each through its own snapshot row (payroll_record_input.adjustment_id, 0205), so a line no longer needs to be one case's alone:
--    each applied case still names exactly one line (DB111).
alter table payroll_adjustment add column valuation_policy_id uuid;
alter table payroll_adjustment add constraint payroll_adjustment_valuation_policy_fk
  foreign key (company_id, valuation_policy_id) references payroll_valuation_policy (company_id, id) on delete restrict;
alter table payroll_adjustment add constraint payroll_adjustment_valued
  check (valuation_policy_id is null or (previous_recognized_units is not null and corrected_units is not null and delta_amount is not null));
alter table payroll_adjustment add constraint payroll_adjustment_approved_valued
  check (state not in ('APPROVED', 'APPLIED') or (valuation_policy_id is not null and delta_amount <> 0));
create index payroll_adjustment_valuation_idx on payroll_adjustment (company_id, valuation_policy_id) where (valuation_policy_id is not null);

drop index payroll_adjustment_one_applied_line;
create index payroll_adjustment_applied_line_idx on payroll_adjustment (company_id, applied_payroll_line_id) where (applied_payroll_line_id is not null);

create or replace function hrms_payroll_adjustment_guard() returns trigger language plpgsql as $$
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
  if old.state <> 'DRAFT' and (new.previous_recognized_units, new.corrected_units, new.delta_amount, new.explanation, new.valuation_policy_id)
     is distinct from (old.previous_recognized_units, old.corrected_units, old.delta_amount, old.explanation, old.valuation_policy_id) then
    raise exception 'a submitted payroll adjustment is immutable' using errcode = '23514';
  end if;
  if new.state <> old.state and not ((old.state = 'DRAFT' and new.state = 'SUBMITTED')
                                     or (old.state = 'SUBMITTED' and new.state in ('APPROVED', 'RETURNED', 'REJECTED'))
                                     or (old.state = 'APPROVED' and new.state in ('APPLIED', 'VOID'))) then
    raise exception 'payroll adjustment state % cannot become %', old.state, new.state using errcode = '23514';
  end if;
  -- Application (FR-100): the processing of a later payroll of the employee names its run and the record's line, once.
  if old.state = 'APPROVED' and new.state = 'APPLIED' then
    if old.target_run_id is not null or old.applied_payroll_line_id is not null or (new.decided_at, new.decided_by) is distinct from (old.decided_at, old.decided_by) then
      raise exception 'a payroll adjustment is applied once' using errcode = '23514';
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
  if (new.target_run_id, new.applied_payroll_line_id) is distinct from (old.target_run_id, old.applied_payroll_line_id) then
    raise exception 'the target of a payroll adjustment is set when it is applied' using errcode = '23514';
  end if;
  return new;
end $$;
