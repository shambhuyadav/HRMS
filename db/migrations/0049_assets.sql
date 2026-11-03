-- 0049 Asset register, custody and custody requests (FR-110; H3 TN16; H1/BR-053; DF02; DF03; DF04; DF08; C4).
-- A minimal register of company items maintained by an authorised Admin, an effective-dated custody history (one
-- holder at a time) with the employee's acknowledgment of receipt, and the employee's custody request decided by an
-- independent eligible Admin. Nothing values, depreciates, writes off or transfers an item: the BRD defines no such
-- policy (B7 "asset custody require approved field dictionaries and rules"; BRD 4.2 lists asset issue/return among
-- the optional areas needing a scope decision). An approved request issues nothing by itself; issuing is the Admin's
-- separate custody action. Every group here is operational (no confidential value is stored).

-- ---------------------------------------------------------------------------
-- Asset register (company property, not employee-scoped). The code is permanent and, because assets are never
-- deleted, never reused. RETIRED is a final state, not a deletion.
-- ---------------------------------------------------------------------------
create table asset (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references company (id) on delete restrict,
  asset_code         text not null check (asset_code = upper(btrim(asset_code)) and asset_code ~ '^[A-Z0-9][A-Z0-9._/-]{0,39}$'),
  -- DF04: a controlled reference list (no free-text value creates a master).
  category_category  text not null default 'ASSET_CATEGORY' check (category_category = 'ASSET_CATEGORY'),
  category_id        uuid not null,
  description        text not null check (btrim(description) <> '' and length(description) <= 500),
  -- Serial number or other identifier, as text (leading zeros kept); no uniqueness is assumed.
  identifier         text check (identifier is null or (btrim(identifier) <> '' and length(identifier) <= 200)),
  state              text not null check (state in ('IN_STOCK', 'ISSUED', 'RETURNED_TO_STOCK', 'RETIRED')),
  retired_on         date,
  retirement_note    text check (retirement_note is null or (btrim(retirement_note) <> '' and length(retirement_note) <= 1000)),
  created_at         timestamptz not null default now(),
  created_by         uuid references user_account (id) on delete restrict,
  updated_at         timestamptz not null default now(),
  updated_by         uuid references user_account (id) on delete restrict,
  version            integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, asset_code),
  foreign key (company_id, category_category, category_id) references reference_value (company_id, category, id) on delete restrict,
  check ((state = 'RETIRED') = (retired_on is not null)),
  check ((retired_on is null) = (retirement_note is null))
);
create index asset_state_idx on asset (company_id, state);

-- A new item starts IN_STOCK. Issue from stock, return to stock, retire from stock only (an issued item is returned
-- first, so its custody is always closed with a date and condition). A retired item is final.
create function hrms_asset_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.state <> 'IN_STOCK' then
      raise exception 'a new asset starts IN_STOCK' using errcode = '23514';
    end if;
    return new;
  end if;
  if new.asset_code is distinct from old.asset_code then
    raise exception 'an asset code is permanent' using errcode = '23514';
  end if;
  if old.state = 'RETIRED' then
    raise exception 'a retired asset is final' using errcode = '23514';
  end if;
  if new.state <> old.state and not (
       (old.state in ('IN_STOCK', 'RETURNED_TO_STOCK') and new.state in ('ISSUED', 'RETIRED'))
    or (old.state = 'ISSUED' and new.state = 'RETURNED_TO_STOCK')) then
    raise exception 'asset state % -> % is not allowed', old.state, new.state using errcode = '23514';
  end if;
  return new;
end $$;

create trigger asset_guard before insert or update on asset for each row execute function hrms_asset_guard();

-- ---------------------------------------------------------------------------
-- Custody request (typed root of business_transaction kind asset_request): the employee asks for an item of a
-- category with a reason; an independent eligible Admin approves or rejects. Immutable once submitted.
-- ---------------------------------------------------------------------------
create table asset_request (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references company (id) on delete restrict,
  employee_id        uuid not null,
  transaction_kind   text not null default 'asset_request' check (transaction_kind = 'asset_request'),
  transaction_id     uuid not null,
  category_category  text not null default 'ASSET_CATEGORY' check (category_category = 'ASSET_CATEGORY'),
  category_id        uuid not null,
  item_description   text check (item_description is null or (btrim(item_description) <> '' and length(item_description) <= 300)),
  reason             text not null check (btrim(reason) <> '' and length(reason) <= 1000),
  -- The client's idempotency key: a repeated submission returns the request it created.
  submit_key         text not null check (length(submit_key) between 8 and 200),
  state              text not null check (state in ('SUBMITTED', 'APPROVED', 'REJECTED', 'WITHDRAWN')),
  decided_at         timestamptz,
  created_at         timestamptz not null default now(),
  created_by         uuid references user_account (id) on delete restrict,
  updated_at         timestamptz not null default now(),
  updated_by         uuid references user_account (id) on delete restrict,
  version            integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, id, employee_id),
  unique (company_id, transaction_id),
  unique (company_id, employee_id, submit_key),
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict,
  foreign key (company_id, category_category, category_id) references reference_value (company_id, category, id) on delete restrict,
  foreign key (company_id, transaction_kind, transaction_id) references business_transaction (company_id, kind, id)
    on delete restrict deferrable initially deferred,
  check ((state in ('APPROVED', 'REJECTED')) = (decided_at is not null))
);
create index asset_request_employee_idx on asset_request (company_id, employee_id, created_at desc);
create index asset_request_state_idx on asset_request (company_id, state);

create function hrms_asset_request_guard() returns trigger language plpgsql as $$
begin
  if (new.employee_id, new.transaction_id, new.category_id, new.item_description, new.reason, new.submit_key)
     is distinct from (old.employee_id, old.transaction_id, old.category_id, old.item_description, old.reason, old.submit_key) then
    raise exception 'a submitted asset request is immutable' using errcode = '23514';
  end if;
  return new;
end $$;

create trigger asset_request_guard before update on asset_request for each row execute function hrms_asset_request_guard();

-- CI12 mirror, checked at commit against the rows as they are then.
create function hrms_asset_request_mirror() returns trigger language plpgsql as $$
declare
  row_state text;
  bt_state text;
begin
  select state into row_state from asset_request where company_id = new.company_id and id = new.id;
  select state into bt_state from business_transaction where company_id = new.company_id and id = new.transaction_id;
  if bt_state is distinct from row_state then
    raise exception 'asset request state % does not match its transaction state %', row_state, bt_state using errcode = '23514';
  end if;
  return null;
end $$;

create constraint trigger asset_request_mirrors_transaction
  after insert or update on asset_request deferrable initially deferred
  for each row execute function hrms_asset_request_mirror();

-- ---------------------------------------------------------------------------
-- Custody history: one row per issue, closed once by the return. Rows are immutable apart from that single closing
-- of the interval; nothing is ever deleted. One holder at a time: one open row per asset and custody intervals of
-- an asset never overlap (a same-day return leaves an empty interval).
-- ---------------------------------------------------------------------------
create table asset_custody (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references company (id) on delete restrict,
  asset_id          uuid not null,
  employee_id       uuid not null,
  -- The approved custody request this issue fulfils, if any (same employee, CI08).
  request_id        uuid,
  issued_on         date not null,
  issue_condition   text not null check (btrim(issue_condition) <> '' and length(issue_condition) <= 1000),
  issue_key         text not null check (length(issue_key) between 8 and 200),
  returned_on       date,
  return_condition  text check (return_condition is null or (btrim(return_condition) <> '' and length(return_condition) <= 1000)),
  returned_by       uuid references user_account (id) on delete restrict,
  returned_at       timestamptz,
  return_key        text check (return_key is null or length(return_key) between 8 and 200),
  created_at        timestamptz not null default now(),
  created_by        uuid not null references user_account (id) on delete restrict,
  updated_at        timestamptz not null default now(),
  updated_by        uuid references user_account (id) on delete restrict,
  version           integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, id, employee_id),
  unique (company_id, issue_key),
  unique (company_id, return_key),
  foreign key (company_id, asset_id) references asset (company_id, id) on delete restrict,
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict,
  foreign key (company_id, request_id, employee_id) references asset_request (company_id, id, employee_id) on delete restrict,
  check (returned_on is null or returned_on >= issued_on),
  check ((returned_on is null) = (return_condition is null)),
  check ((returned_on is null) = (returned_by is null)),
  check ((returned_on is null) = (returned_at is null)),
  check ((returned_on is null) = (return_key is null)),
  exclude using gist (company_id with =, asset_id with =, daterange(issued_on, returned_on, '[)') with &&)
);
create unique index asset_custody_one_open on asset_custody (company_id, asset_id) where (returned_on is null);
-- An approved request is fulfilled by at most one issue.
create unique index asset_custody_one_per_request on asset_custody (company_id, request_id) where (request_id is not null);
create index asset_custody_employee_idx on asset_custody (company_id, employee_id, issued_on desc);
create index asset_custody_asset_idx on asset_custody (company_id, asset_id, issued_on desc);

create function hrms_asset_custody_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.returned_on is not null then
      raise exception 'custody starts open; the return is recorded on the open record' using errcode = '23514';
    end if;
    if new.request_id is not null and not exists (
      select 1 from asset_request r where r.company_id = new.company_id and r.id = new.request_id and r.state = 'APPROVED'
    ) then
      raise exception 'only an approved custody request can be fulfilled' using errcode = '23514';
    end if;
    return new;
  end if;
  if (new.asset_id, new.employee_id, new.request_id, new.issued_on, new.issue_condition, new.issue_key, new.created_by)
     is distinct from (old.asset_id, old.employee_id, old.request_id, old.issued_on, old.issue_condition, old.issue_key, old.created_by) then
    raise exception 'an issue record is immutable' using errcode = '23514';
  end if;
  if old.returned_on is not null then
    raise exception 'a returned custody record is final' using errcode = '23514';
  end if;
  return new;
end $$;

create trigger asset_custody_guard before insert or update on asset_custody for each row execute function hrms_asset_custody_guard();

-- The register and the custody history agree at commit: an asset is ISSUED exactly when it has an open custody row.
create function hrms_asset_custody_agrees(p_company_id uuid, p_asset_id uuid) returns void language plpgsql as $$
declare
  asset_state text;
  open_rows integer;
begin
  select state into asset_state from asset where company_id = p_company_id and id = p_asset_id;
  select count(*) into open_rows from asset_custody where company_id = p_company_id and asset_id = p_asset_id and returned_on is null;
  if (asset_state = 'ISSUED') is distinct from (open_rows = 1) then
    raise exception 'asset % is % with % open custody records', p_asset_id, asset_state, open_rows using errcode = '23514';
  end if;
end $$;

create function hrms_asset_state_check() returns trigger language plpgsql as $$
begin
  perform hrms_asset_custody_agrees(new.company_id, new.id);
  return null;
end $$;

create function hrms_asset_custody_state_check() returns trigger language plpgsql as $$
begin
  perform hrms_asset_custody_agrees(new.company_id, new.asset_id);
  return null;
end $$;

create constraint trigger asset_state_matches_custody
  after insert or update on asset deferrable initially deferred
  for each row execute function hrms_asset_state_check();
create constraint trigger asset_custody_matches_asset_state
  after insert or update on asset_custody deferrable initially deferred
  for each row execute function hrms_asset_custody_state_check();

-- ---------------------------------------------------------------------------
-- Acknowledgment of receipt: the employee's own, once per issue, timestamped, append-only. Only while the item is
-- held, and only by a user linked to the custody's employee.
-- ---------------------------------------------------------------------------
create table asset_custody_acknowledgment (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references company (id) on delete restrict,
  custody_id       uuid not null,
  employee_id      uuid not null,
  acknowledged_at  timestamptz not null default now(),
  acknowledged_by  uuid not null references user_account (id) on delete restrict,
  created_at       timestamptz not null default now(),
  created_by       uuid references user_account (id) on delete restrict,
  unique (company_id, custody_id),
  foreign key (company_id, custody_id, employee_id) references asset_custody (company_id, id, employee_id) on delete restrict
);

create function hrms_asset_acknowledgment_guard() returns trigger language plpgsql as $$
begin
  if exists (select 1 from asset_custody c where c.company_id = new.company_id and c.id = new.custody_id and c.returned_on is not null) then
    raise exception 'a returned item cannot be acknowledged' using errcode = '23514';
  end if;
  if not exists (
    select 1 from user_employee_link l where l.company_id = new.company_id and l.user_id = new.acknowledged_by and l.employee_id = new.employee_id
  ) then
    raise exception 'only the employee holding the item acknowledges its receipt' using errcode = '23514';
  end if;
  return new;
end $$;

create trigger asset_custody_acknowledgment_guard before insert on asset_custody_acknowledgment
  for each row execute function hrms_asset_acknowledgment_guard();
create trigger asset_custody_acknowledgment_append_only before update or delete on asset_custody_acknowledgment
  for each row execute function hrms_append_only();

do $$
declare
  t text;
begin
  foreach t in array array['asset', 'asset_request', 'asset_custody'] loop
    execute format('create trigger %I before update on %I for each row execute function hrms_touch()', t || '_touch', t);
    execute format('create trigger %I before delete on %I for each row execute function hrms_no_delete()', t || '_no_delete', t);
  end loop;
end $$;

-- DF03 request states: approve or reject (no return); the employee may withdraw before the decision.
insert into transaction_kind (kind, root_table, routing_kind) values ('asset_request', 'asset_request', null);
insert into transaction_state (kind, state, initial, terminal) values
  ('asset_request', 'SUBMITTED', true,  false),
  ('asset_request', 'APPROVED',  false, true),
  ('asset_request', 'REJECTED',  false, true),
  ('asset_request', 'WITHDRAWN', false, true);
insert into transaction_transition (kind, from_state, to_state) values
  ('asset_request', 'SUBMITTED', 'APPROVED'),
  ('asset_request', 'SUBMITTED', 'REJECTED'),
  ('asset_request', 'SUBMITTED', 'WITHDRAWN');

-- Catalogue. All operational (the module registration classifies the groups); none is an own-ESS confidential group.
insert into permission (resource, action, field_group) values
  ('asset',         'read',        'operational'),
  ('asset',         'manage',      'operational'),
  ('asset',         'custody',     'operational'),
  ('asset',         'acknowledge', 'operational'),
  ('asset_request', 'submit',      'operational'),
  ('asset_request', 'read',        'operational'),
  ('asset_request', 'decide',      'operational');
