-- 0145 The approved currency codes (CI15 "currency codes, units and rounding scales must use the approved code set"; DF06 "company
-- currency is INR for the initial policy", "two-decimal INR precision"; DF07). Needs hrms_columns_fixed (0141).
--
-- Seeded with INR alone. Adding a currency is Finance's decision (BR-022, OQ-17), made by adding a row, never here. The foreign keys
-- are a backstop behind refusals the service already names, so they sit only where no API request can reach them: the
-- expense policy (INR by request schema and by the service) and money past the submit gate, which copies its currency from a
-- claim that passed it (obligation, batch, instruction, allocation; a payment event keeps no currency of its own).
-- Not here, on purpose:
--   * expense_claim and expense_revision: an unsupported currency "blocks submit" with a named reason (FR-071, BRD line 1233).
--   * payroll, salary, increment, hiring, loan, settlement, tax pack and training columns, and the payroll calendar's minor
--     unit: DF06 and DF07 do not make these INR-only, so which currencies they support is an open question under OQ-17.
create table currency (
  code        text primary key check (code ~ '^[A-Z]{3}$'),
  minor_unit  smallint not null check (minor_unit between 0 and 4),
  created_at  timestamptz not null default now()
);
create trigger currency_fixed before update on currency for each row execute function hrms_columns_fixed('code', 'minor_unit');
create trigger currency_no_delete before delete on currency for each row execute function hrms_no_delete();

insert into currency (code, minor_unit) values ('INR', 2);

-- A stored row in another currency must not stop an upgrade: it is kept, its table's constraint stays NOT VALID (it still applies
-- to every new or changed row) and the migration says so.
do $$
declare
  t text;
begin
  foreach t in array array['expense_policy', 'expense_obligation', 'payment_batch', 'payment_instruction', 'payment_allocation'] loop
    execute format('alter table %I add constraint %I foreign key (currency_code) references currency (code) on delete restrict not valid', t, t || '_currency_fk');
    begin
      execute format('alter table %I validate constraint %I', t, t || '_currency_fk');
    exception when foreign_key_violation then
      raise warning '% holds stored rows in a currency outside the approved codes; they are kept, and % stays NOT VALID', t, t || '_currency_fk';
    end;
  end loop;
end $$;
