-- 0220 Statutory contributions in payroll: PF, ESIC and professional tax (FR-028, FR-031, FR-052; DF05; F4). Decided under owner
-- delegation, 6 Nov 2026 (docs/03 I-85).
--
-- The packs themselves (PF, ESIC and the state professional tax packs) are revisions of the statutory rule pack registry
-- (statutory_rule_pack, 0235), seeded as DRAFTs by modules/statutory/rule-packs.ts ensureStatutoryPacks and valued only once two
-- authorised people have validated and activated them. Nothing here holds a rate, ceiling or slab. On a new database this file runs
-- before 0235 creates the registry, so nothing here refers to that table by a foreign key or a check: a pack revision is named by its
-- code and revision, and its values are copied into the run's pin (4), so the snapshot stands on its own.
--
-- 1. payroll_line.calculation_basis takes RULE_PACK: a line valued by an ACTIVE pack (modules/statutory/evaluate.ts).
-- 2. employee_pf_option: an employee's PF contribution basis, dated (EPF Scheme para 26(6)): on wages up to the pack's ceiling, or on
--    higher wages by joint option. Append-only: a change is a later row; the row in force on a day is the latest that starts on or
--    before it (the highest sequence among those of the same start).
-- 3. location_pt_state: the state whose professional tax applies at a work location, dated. An employee's professional tax state is
--    that of the location of their employment assignment on the record's last eligible day. Append-only, as 2.
-- 4. payroll_run_rule_pack: the pack revision a payroll run revision uses for a pack code, fixed the first time a chunk of the
--    calculation needs it (or fixed as "none active"), with its currency and parameters copied, so every member of the revision is
--    valued under the same values whatever is activated while the chunks run.
-- 5. payroll_record_statutory: the statutory evaluation of a record and RULE_PACK head, written once by the calculation: the pin used,
--    VALUED with its amount (a line) or NOT_APPLICABLE (no line: not covered, or a nil amount), and the workings (wages, rates,
--    coverage, state, month) it was derived from. Lines of basis RULE_PACK are derived from these rows (payroll/calculate.ts linesSql).
-- Nothing stored is changed beyond widening one check, so this cannot stop an upgrade.

-- 1. RULE_PACK lines
alter table payroll_line drop constraint payroll_line_calculation_basis_check;
alter table payroll_line add constraint payroll_line_calculation_basis_check check (calculation_basis in ('FIXED', 'INPUT', 'RULE_PACK'));

-- Append-only dated settings with consecutive sequences per subject (2 and 3).
create function hrms_statutory_setting_sequence() returns trigger language plpgsql as $$
declare
  subject text := case tg_table_name when 'employee_pf_option' then 'employee_id' else 'location_id' end;
  latest integer;
begin
  execute format('select max(sequence) from %I where company_id = $1 and %I = $2', tg_table_name, subject)
     into latest using new.company_id, (to_jsonb(new) ->> subject)::uuid;
  if new.sequence <> coalesce(latest, 0) + 1 then
    raise exception 'the rows of a dated statutory setting are consecutive' using errcode = '23514';
  end if;
  return new;
end $$;

-- 2. PF contribution basis per employee
create table employee_pf_option (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references company (id) on delete restrict,
  employee_id         uuid not null,
  sequence            integer not null check (sequence > 0),
  effective_from      date not null,
  contribution_basis  text not null check (contribution_basis in ('STATUTORY_CEILING', 'HIGHER_WAGES')),
  -- The joint option form or other record the basis rests on (a reference, never a scan or a personal identifier).
  reference           text not null check (btrim(reference) <> '' and length(reference) <= 200),
  created_at          timestamptz not null default now(),
  created_by          uuid not null references user_account (id) on delete restrict,
  unique (company_id, id),
  unique (company_id, employee_id, sequence),
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict
);
create index employee_pf_option_in_force on employee_pf_option (company_id, employee_id, effective_from);
create trigger employee_pf_option_sequence before insert on employee_pf_option for each row execute function hrms_statutory_setting_sequence();
create trigger employee_pf_option_append_only before update or delete on employee_pf_option for each row execute function hrms_append_only();

-- 3. Professional tax state per work location
create table location_pt_state (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references company (id) on delete restrict,
  location_id     uuid not null,
  sequence        integer not null check (sequence > 0),
  effective_from  date not null,
  -- The state code of the PT pack (PT_<state>), e.g. MH or KA.
  state_code      text not null check (state_code ~ '^[A-Z]{2}$'),
  created_at      timestamptz not null default now(),
  created_by      uuid not null references user_account (id) on delete restrict,
  unique (company_id, id),
  unique (company_id, location_id, sequence),
  foreign key (company_id, location_id) references location (company_id, id) on delete restrict
);
create index location_pt_state_in_force on location_pt_state (company_id, location_id, effective_from);
create trigger location_pt_state_sequence before insert on location_pt_state for each row execute function hrms_statutory_setting_sequence();
create trigger location_pt_state_append_only before update or delete on location_pt_state for each row execute function hrms_append_only();

-- 4. The pack revision a run revision uses, per pack code
create table payroll_run_rule_pack (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references company (id) on delete restrict,
  run_id         uuid not null,
  pack_code      text not null check (pack_code ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  -- The ACTIVE statutory_rule_pack revision (code, revision: unique there) in effect on the service period's last day when first
  -- needed; null when none was active, which the revision then keeps.
  pack_revision  integer check (pack_revision > 0),
  currency_code  text check (currency_code ~ '^[A-Z]{3}$'),
  parameters     jsonb check (parameters is null or jsonb_typeof(parameters) = 'object'),
  created_at     timestamptz not null default now(),
  created_by     uuid references user_account (id) on delete restrict,
  unique (company_id, id),
  unique (company_id, id, run_id),
  unique (company_id, run_id, pack_code),
  foreign key (company_id, run_id) references payroll_run (company_id, id) on delete restrict,
  check ((pack_revision is null) = (currency_code is null) and (pack_revision is null) = (parameters is null))
);

create function hrms_payroll_run_rule_pack_guard() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from payroll_run ru where ru.company_id = new.company_id and ru.id = new.run_id and ru.state = 'DRAFT' and ru.calculation_started_at is not null) then
    raise exception 'the rule packs of a payroll run are fixed by its calculation' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger payroll_run_rule_pack_guard before insert on payroll_run_rule_pack for each row execute function hrms_payroll_run_rule_pack_guard();
create trigger payroll_run_rule_pack_append_only before update or delete on payroll_run_rule_pack for each row execute function hrms_append_only();

-- 5. The statutory evaluation of a record's RULE_PACK head
create table payroll_record_statutory (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references company (id) on delete restrict,
  run_id            uuid not null,
  record_id         uuid not null,
  employee_id       uuid not null,
  component_id      uuid not null,
  head_revision_id  uuid not null,
  head_type         text not null check (head_type in ('DEDUCTION', 'EMPLOYER_CONTRIBUTION')),
  -- The head's rule-pack code (PF_EMPLOYEE, ESIC_EMPLOYER, PROFESSIONAL_TAX, ...).
  rule_pack_code    text not null check (rule_pack_code ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  pin_id            uuid not null,
  status            text not null check (status in ('VALUED', 'NOT_APPLICABLE')),
  amount            numeric(19, 4) check (amount > 0),
  -- How the value was reached (wages, rates, ceilings, coverage, state, month): confidential, like the lines.
  workings          jsonb not null check (jsonb_typeof(workings) = 'object'),
  created_at        timestamptz not null default now(),
  created_by        uuid references user_account (id) on delete restrict,
  unique (company_id, id),
  unique (company_id, record_id, component_id),
  foreign key (company_id, record_id, run_id) references payroll_record (company_id, id, run_id) on delete restrict,
  foreign key (company_id, record_id, employee_id) references payroll_record (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, head_revision_id, component_id, head_type) references payroll_head_revision (company_id, id, component_id, head_type) on delete restrict,
  foreign key (company_id, pin_id, run_id) references payroll_run_rule_pack (company_id, id, run_id) on delete restrict,
  check ((status = 'VALUED') = (amount is not null))
);
create index payroll_record_statutory_head_idx on payroll_record_statutory (company_id, head_revision_id);
create index payroll_record_statutory_pin_idx on payroll_record_statutory (company_id, pin_id);
create trigger payroll_record_statutory_guard before insert on payroll_record_statutory for each row execute function hrms_payroll_snapshot_guard();
create trigger payroll_record_statutory_append_only before update or delete on payroll_record_statutory for each row execute function hrms_append_only();
