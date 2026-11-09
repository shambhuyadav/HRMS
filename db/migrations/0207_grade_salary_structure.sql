-- 0207 Grade salary structures and the CTC category (FR-028, FR-029; E08; BR-011; DF05; docs/03 I-40 items 1 and 9). Decided under
-- owner delegation, 6 Nov 2026 (docs/03 I-80): the "approved structure rules" reconciling CTC to components, and what a CTC category is.
--
-- 1. A grade salary structure is a dated revision per grade and currency, drafted by one person and activated by another (as pay heads
--    are), whose lines turn an annual CTC into monthly components, in sequence: a percent of the monthly CTC, a percent of an earlier
--    line, a fixed monthly amount, and exactly one BALANCE line, an earning that takes what is left so the lines add up to the monthly
--    CTC exactly (annual CTC / 12, rounded half-up to the currency's minor unit; each line rounded half-up the same way). Structure lines
--    are CTC: earnings, reimbursements and employer contributions on FIXED heads; employee deductions are not CTC and are not lines.
--    The monthly gross is the earnings and reimbursements (DF05); employer contributions are cost, not pay. A later start takes over.
-- 2. The structure in force for an employee's grade on an arrangement's start, in its currency, is the rule its components must meet:
--    payroll/config.ts setSalaryComponents refuses components or a monthly gross that differ from the derivation. With no structure for
--    the grade, components are entered as before.
-- 3. The CTC category (E08's salary-master filter) is a company list of names for kinds of CTC (for example staff, trainee, contract),
--    recorded on a salary arrangement when it is made and used to filter the salary master. It changes no amount.
create table ctc_category (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references company (id) on delete restrict,
  code        text not null check (code ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  name        text not null check (btrim(name) <> '' and length(name) <= 100),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  created_by  uuid not null references user_account (id) on delete restrict,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references user_account (id) on delete restrict,
  version     integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, code)
);
create trigger ctc_category_touch before update on ctc_category for each row execute function hrms_touch();
create trigger ctc_category_no_delete before delete on ctc_category for each row execute function hrms_no_delete();
create trigger ctc_category_code_fixed before update on ctc_category for each row execute function hrms_columns_fixed('company_id', 'code');

alter table salary_arrangement add column ctc_category_id uuid;
alter table salary_arrangement add constraint salary_arrangement_ctc_category_fk
  foreign key (company_id, ctc_category_id) references ctc_category (company_id, id) on delete restrict;
create index salary_arrangement_ctc_category_idx on salary_arrangement (company_id, ctc_category_id) where (ctc_category_id is not null);

create table grade_salary_structure (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references company (id) on delete restrict,
  grade_id        uuid not null,
  revision        integer not null check (revision > 0),
  effective_from  date not null,
  currency_code   text not null check (currency_code ~ '^[A-Z]{3}$'),
  state           text not null default 'DRAFT' check (state in ('DRAFT', 'ACTIVE', 'SUPERSEDED', 'CANCELLED')),
  created_at      timestamptz not null default now(),
  created_by      uuid not null references user_account (id) on delete restrict,
  activated_at    timestamptz,
  activated_by    uuid references user_account (id) on delete restrict,
  updated_at      timestamptz not null default now(),
  updated_by      uuid references user_account (id) on delete restrict,
  version         integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, grade_id, revision),
  foreign key (company_id, grade_id) references grade (company_id, id) on delete restrict,
  check ((activated_at is null) = (activated_by is null)),
  check (state in ('DRAFT', 'CANCELLED') or activated_by is not null),
  -- Maker-checker: the person who drafted a structure never activates it.
  check (activated_by is null or activated_by <> created_by)
);
create unique index grade_salary_structure_one_active on grade_salary_structure (company_id, grade_id, currency_code, effective_from) where (state = 'ACTIVE');

create table grade_salary_structure_line (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references company (id) on delete restrict,
  structure_id       uuid not null,
  sequence           smallint not null check (sequence between 1 and 99),
  component_id       uuid not null,
  method             text not null check (method in ('PERCENT_OF_CTC', 'PERCENT_OF_COMPONENT', 'FIXED_MONTHLY', 'BALANCE')),
  percent            numeric(7, 4) check (percent > 0 and percent <= 100),
  base_component_id  uuid,
  amount             numeric(19, 4) check (amount >= 0),
  created_at         timestamptz not null default now(),
  created_by         uuid not null references user_account (id) on delete restrict,
  unique (company_id, id),
  unique (company_id, structure_id, sequence),
  unique (company_id, structure_id, component_id),
  foreign key (company_id, structure_id) references grade_salary_structure (company_id, id) on delete restrict,
  foreign key (company_id, component_id) references pay_component (company_id, id) on delete restrict,
  foreign key (company_id, base_component_id) references pay_component (company_id, id) on delete restrict,
  check ((method in ('PERCENT_OF_CTC', 'PERCENT_OF_COMPONENT')) = (percent is not null)),
  check ((method = 'PERCENT_OF_COMPONENT') = (base_component_id is not null)),
  check ((method = 'FIXED_MONTHLY') = (amount is not null)),
  check (base_component_id is null or base_component_id <> component_id)
);
create index grade_salary_structure_line_idx on grade_salary_structure_line (company_id, structure_id, sequence);
create unique index grade_salary_structure_one_balance on grade_salary_structure_line (company_id, structure_id) where (method = 'BALANCE');

-- A structure's rules are fixed once it leaves DRAFT: lines are written only while it is a draft, and never changed or removed.
create function hrms_grade_structure_line_guard() returns trigger language plpgsql as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'the lines of a grade salary structure are never changed or removed' using errcode = '23514';
  end if;
  if (select state from grade_salary_structure where company_id = new.company_id and id = new.structure_id) is distinct from 'DRAFT' then
    raise exception 'lines are added to a grade salary structure only while it is a draft' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger grade_salary_structure_line_guard before insert or update or delete on grade_salary_structure_line
  for each row execute function hrms_grade_structure_line_guard();

create function hrms_grade_structure_guard() returns trigger language plpgsql as $$
begin
  if (new.company_id, new.grade_id, new.revision, new.effective_from, new.currency_code, new.created_at, new.created_by)
     is distinct from (old.company_id, old.grade_id, old.revision, old.effective_from, old.currency_code, old.created_at, old.created_by) then
    raise exception 'a grade salary structure keeps its grade, start, currency and author' using errcode = '23514';
  end if;
  if new.state <> old.state and not ((old.state = 'DRAFT' and new.state in ('ACTIVE', 'CANCELLED')) or (old.state = 'ACTIVE' and new.state = 'SUPERSEDED')) then
    raise exception 'grade salary structure state % cannot become %', old.state, new.state using errcode = '23514';
  end if;
  -- Exactly one BALANCE line, checked when it takes effect.
  if new.state = 'ACTIVE' and old.state = 'DRAFT'
     and (select count(*) from grade_salary_structure_line l where l.company_id = new.company_id and l.structure_id = new.id and l.method = 'BALANCE') <> 1 then
    raise exception 'a grade salary structure takes effect with exactly one BALANCE line' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger grade_salary_structure_guard before update on grade_salary_structure for each row execute function hrms_grade_structure_guard();
create trigger grade_salary_structure_touch before update on grade_salary_structure for each row execute function hrms_touch();
create trigger grade_salary_structure_no_delete before delete on grade_salary_structure for each row execute function hrms_no_delete();
