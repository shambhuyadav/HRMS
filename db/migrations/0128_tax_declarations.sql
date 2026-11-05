-- 0128 Tax declarations and investment proofs: capture and review only (FR-036 "investment declaration checking", FR-108;
-- H3 TN08, TN09; H1; H4 evidence and explanation; BR-053; BR-054; BR-055; DF05 "dated, versioned externally supplied rule
-- packs"; F4; B7).
--
-- No tax is calculated and nothing here reaches payroll: no table holds a rate, slab, limit, formula or valuation, and neither
-- the calculation nor any payroll table reads these tables. Activating a tax_rule_pack lists what an employee may choose; it
-- does not satisfy a RULE_PACK head, which stays RULE_PACK_NOT_CONFIGURED (I-28).
--
-- tax_rule_pack records what an externally supplied pack declares for one fiscal period: its dates, cutoff and currency, its
-- regimes and categories (H3 "selected regime/categories only from active rule pack"). Fixed once created and activated by
-- someone other than its author, as every company policy is. None is seeded. A new revision replaces the active one.
--
-- tax_declaration (TN08) and tax_proof (TN09) are typed roots of business_transaction. Amounts and the selected regime are
-- sealed (security/field-crypto.ts), so they can be read only through the API, by the employee in the Employee OWN context or
-- by a holder of the confidential `tax` group. Fields follow H3 alone; a category-specific field dictionary is B7's and waits.
-- RETURNED and REJECTED are final for the row, which keeps what was reviewed; the employee continues in a new, linked one.

-- ---------------------------------------------------------------------------------------------------------------
-- Rule pack registry: identity, dates, regimes and categories; no calculation content
-- ---------------------------------------------------------------------------------------------------------------
create table tax_rule_pack (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references company (id) on delete restrict,
  code                  text not null check (code ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  revision              integer not null check (revision > 0),
  -- The fiscal period as the pack states it; BRD year boundaries are pending, so nothing is derived or defaulted.
  fiscal_period_code    text not null check (fiscal_period_code ~ '^[A-Z0-9][A-Z0-9_/-]{0,19}$'),
  period_start          date not null,
  period_end            date not null,
  -- Company-local date: the last day declarations and proofs are accepted from employees (FR-108, H3).
  cutoff_date           date not null,
  currency_code         text not null check (currency_code ~ '^[A-Z]{3}$'),
  currency_minor_unit   smallint not null check (currency_minor_unit between 0 and 4),
  -- F4 "obtained and validated for actual jurisdiction/period": where the pack came from and who validated it.
  source_reference      text not null check (btrim(source_reference) <> '' and length(source_reference) <= 500),
  validation_reference  text not null check (btrim(validation_reference) <> '' and length(validation_reference) <= 500),
  state                 text not null check (state in ('DRAFT', 'ACTIVE', 'RETIRED')),
  activated_by          uuid references user_account (id) on delete restrict,
  activated_at          timestamptz,
  created_at            timestamptz not null default now(),
  created_by            uuid references user_account (id) on delete restrict,
  updated_at            timestamptz not null default now(),
  updated_by            uuid references user_account (id) on delete restrict,
  version               integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, id, fiscal_period_code),
  unique (company_id, code, revision),
  check (period_end > period_start),
  check (state = 'DRAFT' or (activated_by is not null and activated_at is not null)),
  check (activated_by is null or created_by is null or activated_by <> created_by)
);
create unique index tax_rule_pack_one_active_period on tax_rule_pack (company_id, fiscal_period_code) where (state = 'ACTIVE');

create function hrms_tax_rule_pack_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.state <> 'DRAFT' then
      raise exception 'a tax rule pack starts as a draft' using errcode = '23514';
    end if;
    return new;
  end if;
  if (new.code, new.revision, new.fiscal_period_code, new.period_start, new.period_end, new.cutoff_date, new.currency_code, new.currency_minor_unit,
      new.source_reference, new.validation_reference)
     is distinct from
     (old.code, old.revision, old.fiscal_period_code, old.period_start, old.period_end, old.cutoff_date, old.currency_code, old.currency_minor_unit,
      old.source_reference, old.validation_reference) then
    raise exception 'a tax rule pack is fixed once created; create a new revision' using errcode = '23514';
  end if;
  if old.state <> 'DRAFT' and (new.activated_by, new.activated_at) is distinct from (old.activated_by, old.activated_at) then
    raise exception 'the activation of a tax rule pack is final' using errcode = '23514';
  end if;
  if new.state <> old.state and not ((old.state = 'DRAFT' and new.state = 'ACTIVE') or (old.state = 'ACTIVE' and new.state = 'RETIRED')) then
    raise exception 'tax rule pack state % cannot become %', old.state, new.state using errcode = '23514';
  end if;
  return new;
end $$;
create trigger tax_rule_pack_guard before insert or update on tax_rule_pack for each row execute function hrms_tax_rule_pack_guard();
create trigger tax_rule_pack_touch before update on tax_rule_pack for each row execute function hrms_touch();
create trigger tax_rule_pack_no_delete before delete on tax_rule_pack for each row execute function hrms_no_delete();

create table tax_rule_pack_regime (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references company (id) on delete restrict,
  pack_id     uuid not null,
  code        text not null check (code ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  name        text not null check (btrim(name) <> '' and length(name) <= 200),
  created_at  timestamptz not null default now(),
  created_by  uuid references user_account (id) on delete restrict,
  unique (company_id, pack_id, code),
  foreign key (company_id, pack_id) references tax_rule_pack (company_id, id) on delete restrict
);

create table tax_rule_pack_category (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references company (id) on delete restrict,
  pack_id      uuid not null,
  regime_code  text not null,
  code         text not null check (code ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  name         text not null check (btrim(name) <> '' and length(name) <= 200),
  created_at   timestamptz not null default now(),
  created_by   uuid references user_account (id) on delete restrict,
  unique (company_id, pack_id, regime_code, code),
  foreign key (company_id, pack_id, regime_code) references tax_rule_pack_regime (company_id, pack_id, code) on delete restrict
);

-- A regime or category belongs to the draft it was created with.
create function hrms_tax_rule_pack_child_guard() returns trigger language plpgsql as $$
begin
  if (select state from tax_rule_pack where company_id = new.company_id and id = new.pack_id) is distinct from 'DRAFT' then
    raise exception 'the regimes and categories of a tax rule pack are fixed with its draft' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger tax_rule_pack_regime_guard before insert on tax_rule_pack_regime for each row execute function hrms_tax_rule_pack_child_guard();
create trigger tax_rule_pack_category_guard before insert on tax_rule_pack_category for each row execute function hrms_tax_rule_pack_child_guard();
create trigger tax_rule_pack_regime_append_only before update or delete on tax_rule_pack_regime for each row execute function hrms_append_only();
create trigger tax_rule_pack_category_append_only before update or delete on tax_rule_pack_category for each row execute function hrms_append_only();

-- ---------------------------------------------------------------------------------------------------------------
-- TN08 tax declaration: DRAFT -> SUBMITTED -> ACCEPTED, RETURNED or REJECTED
-- ---------------------------------------------------------------------------------------------------------------
create table tax_declaration (
  id                      uuid primary key default gen_random_uuid(),
  company_id              uuid not null references company (id) on delete restrict,
  employee_id             uuid not null,
  transaction_kind        text not null default 'tax_declaration' check (transaction_kind = 'tax_declaration'),
  transaction_id          uuid not null,
  rule_pack_id            uuid not null,
  fiscal_period_code      text not null,
  -- Sealed {regimeCode, lines: [{categoryCode, amount}]}, bound to this row and owner; never readable in SQL.
  sealed_values           text not null check (sealed_values like 'v1.%'),
  line_count              integer not null check (line_count >= 0),
  state                   text not null check (state in ('DRAFT', 'SUBMITTED', 'ACCEPTED', 'RETURNED', 'REJECTED')),
  -- The returned or rejected declaration of the same period this one continues (DF03; BR-055).
  follows_declaration_id  uuid,
  submitted_at            timestamptz,
  decided_at              timestamptz,
  decided_by              uuid references user_account (id) on delete restrict,
  -- H4: the employee-visible explanation of a return or rejection, apart from the reviewer's private reason.
  employee_explanation    text check (employee_explanation is null or (btrim(employee_explanation) <> '' and length(employee_explanation) <= 1000)),
  created_at              timestamptz not null default now(),
  created_by              uuid references user_account (id) on delete restrict,
  updated_at              timestamptz not null default now(),
  updated_by              uuid references user_account (id) on delete restrict,
  version                 integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, id, employee_id),
  unique (company_id, transaction_id),
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict,
  -- A declaration's period is its pack's.
  foreign key (company_id, rule_pack_id, fiscal_period_code) references tax_rule_pack (company_id, id, fiscal_period_code) on delete restrict,
  foreign key (company_id, transaction_kind, transaction_id) references business_transaction (company_id, kind, id)
    on delete restrict deferrable initially deferred,
  foreign key (company_id, follows_declaration_id, employee_id) references tax_declaration (company_id, id, employee_id) on delete restrict,
  check (follows_declaration_id is null or follows_declaration_id <> id),
  check ((state = 'DRAFT') = (submitted_at is null)),
  check ((state in ('ACCEPTED', 'RETURNED', 'REJECTED')) = (decided_at is not null)),
  check ((decided_at is null) = (decided_by is null)),
  check (state not in ('RETURNED', 'REJECTED') or employee_explanation is not null),
  check (state in ('RETURNED', 'REJECTED') or employee_explanation is null)
);
-- One declaration in force per employee and fiscal period; a returned or rejected one no longer counts.
create unique index tax_declaration_one_live on tax_declaration (company_id, employee_id, fiscal_period_code) where (state in ('DRAFT', 'SUBMITTED', 'ACCEPTED'));
create unique index tax_declaration_one_successor on tax_declaration (company_id, follows_declaration_id) where (follows_declaration_id is not null);
create index tax_declaration_review_idx on tax_declaration (company_id, state, created_at desc);

create function hrms_tax_declaration_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.state <> 'DRAFT' then
      raise exception 'a tax declaration starts as a draft' using errcode = '23514';
    end if;
    return new;
  end if;
  if (new.employee_id, new.transaction_id, new.fiscal_period_code, new.follows_declaration_id)
     is distinct from (old.employee_id, old.transaction_id, old.fiscal_period_code, old.follows_declaration_id) then
    raise exception 'the owner and period of a tax declaration are fixed' using errcode = '23514';
  end if;
  if old.state <> 'DRAFT' and (new.sealed_values, new.line_count, new.rule_pack_id) is distinct from (old.sealed_values, old.line_count, old.rule_pack_id) then
    raise exception 'a submitted tax declaration is immutable' using errcode = '23514';
  end if;
  if new.state <> old.state and not ((old.state = 'DRAFT' and new.state = 'SUBMITTED') or (old.state = 'SUBMITTED' and new.state in ('ACCEPTED', 'RETURNED', 'REJECTED'))) then
    raise exception 'tax declaration state % cannot become %', old.state, new.state using errcode = '23514';
  end if;
  return new;
end $$;
create trigger tax_declaration_guard before insert or update on tax_declaration for each row execute function hrms_tax_declaration_guard();
create trigger tax_declaration_touch before update on tax_declaration for each row execute function hrms_touch();
create trigger tax_declaration_no_delete before delete on tax_declaration for each row execute function hrms_no_delete();
create constraint trigger tax_declaration_mirrors_transaction after insert or update on tax_declaration
  deferrable initially deferred for each row execute function hrms_payroll_mirror();

-- ---------------------------------------------------------------------------------------------------------------
-- TN09 investment proof: SUBMITTED -> ACCEPTED, RETURNED or REJECTED. Evidence is transaction_evidence (0048).
-- ---------------------------------------------------------------------------------------------------------------
create table tax_proof (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references company (id) on delete restrict,
  employee_id           uuid not null,
  transaction_kind      text not null default 'tax_proof' check (transaction_kind = 'tax_proof'),
  transaction_id        uuid not null,
  declaration_id        uuid not null,
  category_code         text not null check (category_code ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  -- Sealed {claimedAmount}; the reviewer's figures are sealed apart once decided: {acceptedAmount, rejectedAmount}.
  sealed_values         text not null check (sealed_values like 'v1.%'),
  sealed_decision       text check (sealed_decision is null or sealed_decision like 'v1.%'),
  submit_key            text not null check (length(submit_key) between 8 and 100),
  state                 text not null check (state in ('SUBMITTED', 'ACCEPTED', 'RETURNED', 'REJECTED')),
  follows_proof_id      uuid,
  decided_at            timestamptz,
  decided_by            uuid references user_account (id) on delete restrict,
  employee_explanation  text check (employee_explanation is null or (btrim(employee_explanation) <> '' and length(employee_explanation) <= 1000)),
  created_at            timestamptz not null default now(),
  created_by            uuid references user_account (id) on delete restrict,
  updated_at            timestamptz not null default now(),
  updated_by            uuid references user_account (id) on delete restrict,
  version               integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, id, employee_id),
  unique (company_id, transaction_id),
  unique (company_id, employee_id, submit_key),
  foreign key (company_id, declaration_id, employee_id) references tax_declaration (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, transaction_kind, transaction_id) references business_transaction (company_id, kind, id)
    on delete restrict deferrable initially deferred,
  foreign key (company_id, follows_proof_id, employee_id) references tax_proof (company_id, id, employee_id) on delete restrict,
  check (follows_proof_id is null or follows_proof_id <> id),
  check ((state = 'SUBMITTED') = (decided_at is null)),
  check ((decided_at is null) = (decided_by is null)),
  -- H3: reviewer status and accepted/rejected amount; a return decides no amount.
  check ((state in ('ACCEPTED', 'REJECTED')) = (sealed_decision is not null)),
  check (state not in ('RETURNED', 'REJECTED') or employee_explanation is not null),
  check (state in ('RETURNED', 'REJECTED') or employee_explanation is null)
);
create unique index tax_proof_one_successor on tax_proof (company_id, follows_proof_id) where (follows_proof_id is not null);
create index tax_proof_declaration_idx on tax_proof (company_id, declaration_id, created_at);
create index tax_proof_review_idx on tax_proof (company_id, state, created_at desc);

create function hrms_tax_proof_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.state <> 'SUBMITTED' or new.sealed_decision is not null then
      raise exception 'an investment proof starts undecided' using errcode = '23514';
    end if;
    return new;
  end if;
  if (new.employee_id, new.transaction_id, new.declaration_id, new.category_code, new.sealed_values, new.submit_key, new.follows_proof_id)
     is distinct from (old.employee_id, old.transaction_id, old.declaration_id, old.category_code, old.sealed_values, old.submit_key, old.follows_proof_id) then
    raise exception 'a submitted investment proof is immutable' using errcode = '23514';
  end if;
  if old.state <> 'SUBMITTED' then
    raise exception 'the decision on an investment proof is final' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger tax_proof_guard before insert or update on tax_proof for each row execute function hrms_tax_proof_guard();
create trigger tax_proof_touch before update on tax_proof for each row execute function hrms_touch();
create trigger tax_proof_no_delete before delete on tax_proof for each row execute function hrms_no_delete();
create constraint trigger tax_proof_mirrors_transaction after insert or update on tax_proof
  deferrable initially deferred for each row execute function hrms_payroll_mirror();

-- ---------------------------------------------------------------------------------------------------------------
-- Transaction kinds and permissions (DF03; H1; BR-053). One reviewer list serves both kinds.
-- ---------------------------------------------------------------------------------------------------------------
insert into transaction_kind (kind, root_table, routing_kind) values ('tax_declaration', 'tax_declaration', null);
insert into transaction_kind (kind, root_table, routing_kind) values ('tax_proof', 'tax_proof', 'tax_declaration');

insert into transaction_state (kind, state, initial, terminal) values
  ('tax_declaration', 'DRAFT',     true,  false),
  ('tax_declaration', 'SUBMITTED', false, false),
  ('tax_declaration', 'ACCEPTED',  false, true),
  ('tax_declaration', 'RETURNED',  false, true),
  ('tax_declaration', 'REJECTED',  false, true),
  ('tax_proof',       'SUBMITTED', true,  false),
  ('tax_proof',       'ACCEPTED',  false, true),
  ('tax_proof',       'RETURNED',  false, true),
  ('tax_proof',       'REJECTED',  false, true);

insert into transaction_transition (kind, from_state, to_state) values
  ('tax_declaration', 'DRAFT',     'SUBMITTED'),
  ('tax_declaration', 'SUBMITTED', 'ACCEPTED'),
  ('tax_declaration', 'SUBMITTED', 'RETURNED'),
  ('tax_declaration', 'SUBMITTED', 'REJECTED'),
  ('tax_proof',       'SUBMITTED', 'ACCEPTED'),
  ('tax_proof',       'SUBMITTED', 'RETURNED'),
  ('tax_proof',       'SUBMITTED', 'REJECTED');

-- `tax` is confidential by default (BR-043): the Employee OWN context holds own_tax for its own record only (own-ESS); review
-- is a ceiling-only grant of the HR Administrator role (DF02). The pack registry uses the payroll configuration duties.
insert into permission (resource, action, field_group, own_ess) values
  ('own_tax',         'read',   'tax', true),
  ('own_tax',         'submit', 'tax', true),
  ('tax_declaration', 'read',   'tax', false),
  ('tax_declaration', 'review', 'tax', false);
