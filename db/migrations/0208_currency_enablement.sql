-- 0208 Which currencies the company uses (OQ-17; CI15; DF06; DF07; BR-022; FR-071). Decided under owner delegation, 6 Nov 2026
-- (docs/03 I-80, A6). This replaces the coordinator's first "INR only for payroll" text: payroll was already built to pay in the
-- currency of an active payroll calendar (a calendar is activated by someone other than its author; loans refuse a currency no active
-- calendar pays in; 0172 holds one currency per run, record and segment), and synthetic USD calendars are tested on purpose, so the
-- safeguard is kept where it already is instead of removing a two-person-controlled capability.
--
-- 1. Payroll, salary, increments, settlements, loans and offers use the currency of an active payroll calendar; INR is the seeded
--    company currency. A calendar's currency is one of the approved codes and its minor unit is the reference's (CI15): a calendar
--    whose currency or minor unit is not the reference's is refused (UNSUPPORTED_CURRENCY, CURRENCY_MINOR_UNIT_MISMATCH; the key
--    below backs it for any writer).
-- 2. The ISO codes Finance would use are added to the reference (USD, EUR, GBP, AED, SGD; ISO 4217 minor unit 2). Being in the
--    reference makes a currency nameable, never usable: expense claims in a currency other than the policy's are accepted only once
--    Finance enables it for the company (company_currency, drafted by one person and activated by another) and a dated exchange rate
--    converts it (I-87, a later package); until then submission is refused with a named reason (UNSUPPORTED_CURRENCY while not
--    enabled, EXCHANGE_RATE_NOT_CONFIGURED once enabled).
insert into currency (code, minor_unit) values ('USD', 2), ('EUR', 2), ('GBP', 2), ('AED', 2), ('SGD', 2) on conflict (code) do nothing;

alter table currency add constraint currency_code_minor_unit unique (code, minor_unit);

-- A stored calendar outside the reference must not stop an upgrade: it is kept and the key stays NOT VALID (it still applies to every
-- new or changed row), as in 0145.
do $$
begin
  alter table payroll_calendar add constraint payroll_calendar_currency_fk
    foreign key (currency_code, currency_minor_unit) references currency (code, minor_unit) on delete restrict not valid;
  begin
    alter table payroll_calendar validate constraint payroll_calendar_currency_fk;
  exception when foreign_key_violation then
    raise warning 'payroll_calendar holds stored calendars whose currency or minor unit is not the reference''s; they are kept, and payroll_calendar_currency_fk stays NOT VALID';
  end;
end $$;

create table company_currency (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references company (id) on delete restrict,
  currency_code  text not null references currency (code) on delete restrict,
  -- What the currency is enabled for. Payroll currencies come from active payroll calendars, so only expenses are enabled here.
  purpose        text not null default 'EXPENSE' check (purpose in ('EXPENSE')),
  state          text not null default 'DRAFT' check (state in ('DRAFT', 'ACTIVE', 'RETIRED', 'CANCELLED')),
  reason         text not null check (btrim(reason) <> '' and length(reason) <= 500),
  created_at     timestamptz not null default now(),
  created_by     uuid not null references user_account (id) on delete restrict,
  activated_at   timestamptz,
  activated_by   uuid references user_account (id) on delete restrict,
  retired_at     timestamptz,
  retired_by     uuid references user_account (id) on delete restrict,
  updated_at     timestamptz not null default now(),
  updated_by     uuid references user_account (id) on delete restrict,
  version        integer not null default 1 check (version > 0),
  unique (company_id, id),
  check ((activated_at is null) = (activated_by is null)),
  check (state in ('DRAFT', 'CANCELLED') or activated_by is not null),
  -- Maker-checker: whoever asks for a currency never enables it.
  check (activated_by is null or activated_by <> created_by),
  check ((state = 'RETIRED') = (retired_at is not null)),
  check ((retired_at is null) = (retired_by is null))
);
create unique index company_currency_one_live on company_currency (company_id, currency_code, purpose) where (state in ('DRAFT', 'ACTIVE'));

create function hrms_company_currency_guard() returns trigger language plpgsql as $$
begin
  if (new.company_id, new.currency_code, new.purpose, new.reason, new.created_at, new.created_by)
     is distinct from (old.company_id, old.currency_code, old.purpose, old.reason, old.created_at, old.created_by) then
    raise exception 'an enabled currency keeps its company, code, purpose, reason and author' using errcode = '23514';
  end if;
  if new.state <> old.state and not ((old.state = 'DRAFT' and new.state in ('ACTIVE', 'CANCELLED')) or (old.state = 'ACTIVE' and new.state = 'RETIRED')) then
    raise exception 'company currency state % cannot become %', old.state, new.state using errcode = '23514';
  end if;
  return new;
end $$;
create trigger company_currency_guard before update on company_currency for each row execute function hrms_company_currency_guard();
create trigger company_currency_touch before update on company_currency for each row execute function hrms_touch();
create trigger company_currency_no_delete before delete on company_currency for each row execute function hrms_no_delete();
