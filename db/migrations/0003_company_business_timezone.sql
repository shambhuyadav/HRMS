-- 0003 Company business timezone (DF05: configurable per company, initial Asia/Kolkata).
-- Effective-dated rules (assignments, reporting lines, policies) resolve "today" in this zone.

alter table company add column business_timezone text not null default 'Asia/Kolkata';

create function hrms_valid_timezone() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from pg_timezone_names where name = new.business_timezone) then
    raise exception 'unknown timezone %', new.business_timezone using errcode = '23514';
  end if;
  return new;
end $$;

create trigger company_valid_timezone
  before insert or update of business_timezone on company
  for each row execute function hrms_valid_timezone();

-- Business date of a company at an instant.
create function hrms_business_date(p_company_id uuid, p_at timestamptz) returns date
language sql stable as $$
  select (p_at at time zone c.business_timezone)::date from company c where c.id = p_company_id
$$;
