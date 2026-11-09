-- 0213 External deduction mapping (FR-028 "external deduction mapping"; FR-031; DF05; docs/10 A4a). Decided under owner delegation,
-- 6 Nov 2026 (docs/03 I-91): a deduction the company collects for an outside party (canteen, society, insurance and the like) arrives
-- under that party's own code. A dated master, drafted by one person and activated by another, maps each outside code to a pay
-- component whose head is a DEDUCTION on the INPUT basis. Payroll inputs may name the outside code instead of the component; the
-- mapping in force on the input's effective date resolves it. An unknown code, a code with no mapping in force on that date, or a code
-- whose mapping in force was retired, rejects the row by name; nothing ever falls back to a default component.
create table payroll_external_deduction (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references company (id) on delete restrict,
  external_code   text not null check (external_code ~ '^[A-Z][A-Z0-9_-]{0,39}$'),
  name            text not null check (btrim(name) <> '' and length(name) <= 200),
  component_id    uuid not null,
  effective_from  date not null,
  reason          text not null check (btrim(reason) <> '' and length(reason) <= 500),
  state           text not null default 'DRAFT' check (state in ('DRAFT', 'ACTIVE', 'SUPERSEDED', 'RETIRED', 'CANCELLED')),
  created_at      timestamptz not null default now(),
  created_by      uuid not null references user_account (id) on delete restrict,
  activated_at    timestamptz,
  activated_by    uuid references user_account (id) on delete restrict,
  retired_at      timestamptz,
  retired_by      uuid references user_account (id) on delete restrict,
  updated_at      timestamptz not null default now(),
  updated_by      uuid references user_account (id) on delete restrict,
  version         integer not null default 1 check (version > 0),
  unique (company_id, id),
  foreign key (company_id, component_id) references pay_component (company_id, id) on delete restrict,
  check ((activated_at is null) = (activated_by is null)),
  check (state in ('DRAFT', 'CANCELLED') or activated_by is not null),
  -- Maker-checker: whoever drafts a mapping never activates it.
  check (activated_by is null or activated_by <> created_by),
  check ((state = 'RETIRED') = (retired_at is not null)),
  check ((retired_at is null) = (retired_by is null))
);
create unique index payroll_external_deduction_one_active on payroll_external_deduction (company_id, external_code, effective_from) where (state = 'ACTIVE');
create index payroll_external_deduction_lookup_idx on payroll_external_deduction (company_id, external_code, effective_from desc) where (state in ('ACTIVE', 'RETIRED'));

create function hrms_external_deduction_guard() returns trigger language plpgsql as $$
begin
  if (new.company_id, new.external_code, new.name, new.component_id, new.effective_from, new.reason, new.created_at, new.created_by)
     is distinct from (old.company_id, old.external_code, old.name, old.component_id, old.effective_from, old.reason, old.created_at, old.created_by) then
    raise exception 'an external deduction mapping keeps its code, component, start, reason and author' using errcode = '23514';
  end if;
  if new.state <> old.state and not ((old.state = 'DRAFT' and new.state in ('ACTIVE', 'CANCELLED')) or (old.state = 'ACTIVE' and new.state in ('SUPERSEDED', 'RETIRED'))) then
    raise exception 'external deduction mapping state % cannot become %', old.state, new.state using errcode = '23514';
  end if;
  return new;
end $$;
create trigger payroll_external_deduction_guard before update on payroll_external_deduction for each row execute function hrms_external_deduction_guard();
create trigger payroll_external_deduction_touch before update on payroll_external_deduction for each row execute function hrms_touch();
create trigger payroll_external_deduction_no_delete before delete on payroll_external_deduction for each row execute function hrms_no_delete();

-- The input keeps the outside code it was entered under, for the reconciliation with the outside party.
alter table payroll_input add column external_code text check (external_code is null or external_code ~ '^[A-Z][A-Z0-9_-]{0,39}$');
