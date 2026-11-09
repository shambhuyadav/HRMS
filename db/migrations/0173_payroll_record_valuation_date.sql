-- 0173 CI07 "payroll_record.salary_arrangement_id ... is applicable under the owner-approved payroll valuation date rule". The owner
-- delegated the rule (6 Nov 2026, docs/03): each day of a service period is valued with the employee's salary arrangement in force on that
-- day (effective_from <= day < effective_to, not superseded); a period spanning a change is split into segments; the record names the
-- arrangement of its last segment. The calculation already works so (payroll/calculate.ts steps 5 and 9); this holds a direct write to the
-- same rule when a record is completed, and for a segment added while its run is still a draft, as 0172 does for currency. Nothing stored
-- is read or changed, so this cannot stop an upgrade; db/pre-go-live-check.ts reports what a stored record can still show of it.
create function hrms_payroll_record_valuation_date() returns trigger language plpgsql as $$
declare
  the_record uuid;
begin
  if tg_table_name = 'payroll_record' then
    the_record := new.id;
  else
    the_record := new.record_id;
  end if;
  if exists (
    select 1
      from payroll_record r
      join payroll_record_segment s on s.company_id = r.company_id and s.record_id = r.id
      join salary_arrangement a on a.company_id = s.company_id and a.id = s.salary_arrangement_id
     where r.company_id = new.company_id and r.id = the_record and r.calculation_status = 'CALCULATED'
       and not (a.effective_from <= s.segment_start and (a.effective_to is null or a.effective_to > s.segment_end) and a.superseded_at is null)
  ) or exists (
    select 1
      from payroll_record r
     where r.company_id = new.company_id and r.id = the_record and r.calculation_status = 'CALCULATED'
       and r.salary_arrangement_id is distinct from (
             select s.salary_arrangement_id from payroll_record_segment s
              where s.company_id = r.company_id and s.record_id = r.id order by s.segment_end desc limit 1)
  ) then
    raise exception 'a calculated payroll record is valued with the arrangement in force on each of its days and names the one of its last segment'
      using errcode = '23514';
  end if;
  return null;
end $$;

create constraint trigger payroll_record_valuation_date after update of calculation_status on payroll_record
  deferrable initially deferred for each row when (new.calculation_status = 'CALCULATED')
  execute function hrms_payroll_record_valuation_date();

create constraint trigger payroll_segment_valuation_date after insert on payroll_record_segment
  deferrable initially deferred for each row
  execute function hrms_payroll_record_valuation_date();
