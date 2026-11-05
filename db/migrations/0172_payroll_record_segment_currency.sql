-- 0172 A calculated payroll record holds only segments in its own currency (CI07 "monetary currency/sign agree"). The calculation already
-- refuses another currency (CURRENCY_MISMATCH: the record fails, with no figures); this holds a direct write to the same rule. A segment may
-- differ from its record while the record has failed, so a plain key would be wrong. Deferred, because the calculation writes the segments
-- and the outcome in one transaction. On both tables, because while the run is a draft a segment can still be added to a record already
-- calculated (hrms_payroll_snapshot_guard); after that, and for any update, that guard and hrms_append_only already refuse. It reads no
-- valuation date: which arrangement applies to a period waits on the owner (docs/03 I-75 item 4). Nothing stored is read or changed, so this
-- cannot stop an upgrade; a stored row breaking the rule is reported by db/pre-go-live-check.ts.
create function hrms_payroll_record_segment_currency() returns trigger language plpgsql as $$
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
     where r.company_id = new.company_id and r.id = the_record and r.calculation_status = 'CALCULATED' and s.currency_code <> r.currency_code
  ) then
    raise exception 'a calculated payroll record holds only segments in its own currency' using errcode = '23514';
  end if;
  return null;
end $$;

create constraint trigger payroll_record_segment_currency after update of calculation_status on payroll_record
  deferrable initially deferred for each row when (new.calculation_status = 'CALCULATED')
  execute function hrms_payroll_record_segment_currency();

create constraint trigger payroll_segment_record_currency after insert on payroll_record_segment
  deferrable initially deferred for each row
  execute function hrms_payroll_record_segment_currency();
