-- 0255 Hold review cadence narrowed by policy (FR-101; H2 "Hold review reminder is daily, first escalation after 2 business days and
-- subsequent review every 5 business days while unresolved. Policy may narrow these values through approved versioning"; docs/03 I-66
-- "payroll-8"). Decided under owner delegation (6 Nov 2026): a hold criterion revision may narrow the two escalation intervals, never widen
-- them, so the first escalation comes after 1 or 2 business days and later ones every 1 to 5 business days; null keeps the H2 defaults
-- (2 and 5). The values are part of the revision (independently activated, fixed once created). Each policy hold and each applied salary
-- stop copies them from the criterion revision it was decided under, and keeps them for good, so a later revision never changes the
-- cadence of a hold already open. An automatic payment safety block has no criterion and always keeps the defaults. Daily reminders are
-- unchanged. Existing criteria and holds keep the defaults (nothing is backfilled).

alter table payroll_hold_criterion
  add column first_escalation_business_days smallint check (first_escalation_business_days between 1 and 2),
  add column escalation_interval_business_days smallint check (escalation_interval_business_days between 1 and 5);

alter table payroll_hold
  add column first_escalation_business_days smallint check (first_escalation_business_days between 1 and 2),
  add column escalation_interval_business_days smallint check (escalation_interval_business_days between 1 and 5),
  add constraint payroll_hold_safety_block_default_cadence
    check (hold_kind <> 'PAYMENT_SAFETY_BLOCK' or (first_escalation_business_days is null and escalation_interval_business_days is null));

-- A criterion revision's cadence is fixed once created, like the rest of the revision (0043 hrms_payroll_hold_criterion_guard).
create function hrms_payroll_hold_criterion_cadence_fixed() returns trigger language plpgsql as $$
begin
  if (new.first_escalation_business_days, new.escalation_interval_business_days)
     is distinct from (old.first_escalation_business_days, old.escalation_interval_business_days) then
    raise exception 'a hold criterion revision is fixed once created' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger payroll_hold_criterion_cadence_fixed before update on payroll_hold_criterion
  for each row execute function hrms_payroll_hold_criterion_cadence_fixed();

-- A hold carries exactly the cadence of its criterion revision (none for a safety block), and never changes it.
create function hrms_payroll_hold_cadence() returns trigger language plpgsql as $$
declare
  first_days smallint;
  interval_days smallint;
begin
  if tg_op = 'INSERT' then
    if new.criterion_id is not null then
      select c.first_escalation_business_days, c.escalation_interval_business_days into first_days, interval_days
        from payroll_hold_criterion c where c.company_id = new.company_id and c.id = new.criterion_id;
    end if;
    if (new.first_escalation_business_days, new.escalation_interval_business_days) is distinct from (first_days, interval_days) then
      raise exception 'a hold takes the review cadence of its criterion revision' using errcode = '23514';
    end if;
    return new;
  end if;
  if (new.first_escalation_business_days, new.escalation_interval_business_days)
     is distinct from (old.first_escalation_business_days, old.escalation_interval_business_days) then
    raise exception 'a hold case is immutable apart from its decisions' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger payroll_hold_cadence before insert or update on payroll_hold for each row execute function hrms_payroll_hold_cadence();
