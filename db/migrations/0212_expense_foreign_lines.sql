-- 0212 Expense lines in another currency, converted once at submission (OQ-17; FR-070; FR-071; DF07; BR-017; BR-022). Decided under owner
-- delegation, 6 Nov 2026 (docs/03 I-87, items 3-5 of I-80's A6).
--
-- 1. Rates: a dated company exchange rate per currency (INR for one unit of it), drafted by one person and activated by another, for
--    a currency Finance enabled (company_currency, 0208). The rate in force on an expense date is the active one with the latest start
--    on or before it. The claimant never types a rate.
-- 2. Lines: a claim stays in the policy currency (INR), the currency it is reimbursed in through the existing direct or payroll route
--    (DF07); a line may carry its own currency (source_currency_code) with its amounts in that currency. Until submission such a line
--    has no INR amounts (FR-070: a missing rate never stops a draft being saved). Submission converts each one once at the rate in
--    force on its expense date (foreign amount x rate, rounded half-up to the claim currency's minor unit), and freezes the rate and the
--    INR amounts with the revision (BR-017). The claim total is the sum of the converted lines; a later rate never revalues it, and a
--    reversal pays back the original INR amount (the obligation's approved amount, unchanged).
create table expense_exchange_rate (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references company (id) on delete restrict,
  currency_code   text not null references currency (code) on delete restrict,
  effective_from  date not null,
  -- INR for one unit of the currency.
  rate            numeric(19, 8) not null check (rate > 0),
  reason          text not null check (btrim(reason) <> '' and length(reason) <= 500),
  state           text not null default 'DRAFT' check (state in ('DRAFT', 'ACTIVE', 'SUPERSEDED', 'CANCELLED')),
  created_at      timestamptz not null default now(),
  created_by      uuid not null references user_account (id) on delete restrict,
  activated_at    timestamptz,
  activated_by    uuid references user_account (id) on delete restrict,
  updated_at      timestamptz not null default now(),
  updated_by      uuid references user_account (id) on delete restrict,
  version         integer not null default 1 check (version > 0),
  unique (company_id, id),
  check (currency_code <> 'INR'),
  check ((activated_at is null) = (activated_by is null)),
  check (state in ('DRAFT', 'CANCELLED') or activated_by is not null),
  -- Maker-checker: whoever enters a rate never activates it.
  check (activated_by is null or activated_by <> created_by)
);
create unique index expense_exchange_rate_one_active on expense_exchange_rate (company_id, currency_code, effective_from) where (state = 'ACTIVE');
create index expense_exchange_rate_lookup_idx on expense_exchange_rate (company_id, currency_code, effective_from desc) where (state = 'ACTIVE');

create function hrms_expense_exchange_rate_guard() returns trigger language plpgsql as $$
begin
  if (new.company_id, new.currency_code, new.effective_from, new.rate, new.reason, new.created_at, new.created_by)
     is distinct from (old.company_id, old.currency_code, old.effective_from, old.rate, old.reason, old.created_at, old.created_by) then
    raise exception 'an exchange rate keeps its currency, date, rate, reason and author' using errcode = '23514';
  end if;
  if new.state <> old.state and not ((old.state = 'DRAFT' and new.state in ('ACTIVE', 'CANCELLED')) or (old.state = 'ACTIVE' and new.state = 'SUPERSEDED')) then
    raise exception 'exchange rate state % cannot become %', old.state, new.state using errcode = '23514';
  end if;
  return new;
end $$;
create trigger expense_exchange_rate_guard before update on expense_exchange_rate for each row execute function hrms_expense_exchange_rate_guard();
create trigger expense_exchange_rate_touch before update on expense_exchange_rate for each row execute function hrms_touch();
create trigger expense_exchange_rate_no_delete before delete on expense_exchange_rate for each row execute function hrms_no_delete();

alter table expense_line add column source_currency_code text references currency (code) on delete restrict,
                         add column source_gross_amount numeric(19, 4),
                         add column source_claimed_amount numeric(19, 4),
                         add column exchange_rate numeric(19, 8),
                         add column exchange_rate_id uuid;
alter table expense_line add constraint expense_line_exchange_rate_fk
  foreign key (company_id, exchange_rate_id) references expense_exchange_rate (company_id, id) on delete restrict;
alter table expense_line alter column gross_amount drop not null, alter column claimed_amount drop not null;
alter table expense_line add constraint expense_line_source_amounts check (
  (source_currency_code is null) = (source_gross_amount is null) and (source_currency_code is null) = (source_claimed_amount is null)
  and (source_gross_amount is null or (source_gross_amount > 0 and source_gross_amount = round(source_gross_amount, 2)))
  and (source_claimed_amount is null or (source_claimed_amount > 0 and source_claimed_amount = round(source_claimed_amount, 2)
                                         and source_claimed_amount <= source_gross_amount)));
alter table expense_line add constraint expense_line_rate_pair check ((exchange_rate is null) = (exchange_rate_id is null) and (exchange_rate is null or source_currency_code is not null));
-- A line in the claim currency always has its amounts; a foreign one has INR amounts exactly when it is converted.
alter table expense_line add constraint expense_line_amounts_known check (
  (gross_amount is null) = (claimed_amount is null)
  and (gross_amount is not null) = (source_currency_code is null or exchange_rate is not null));
create index expense_line_exchange_rate_idx on expense_line (company_id, exchange_rate_id) where (exchange_rate_id is not null);

-- A revision is submitted only with every line in the claim currency (converted where foreign).
create function hrms_expense_revision_converted() returns trigger language plpgsql as $$
begin
  if new.submitted_at is not null and old.submitted_at is null
     and exists (select 1 from expense_line l where l.company_id = new.company_id and l.revision_id = new.id and l.gross_amount is null) then
    raise exception 'an expense revision is submitted with every line converted to the claim currency' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger expense_revision_converted before update on expense_revision for each row execute function hrms_expense_revision_converted();
