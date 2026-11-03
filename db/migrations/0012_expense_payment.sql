-- 0012 Expense claims and manual payment-outcome tracking
-- (DB047-DB059; FR-070-FR-079; BR-017-BR-025; C5; DF06; DF07; CI03-CI06; ZT13-ZT15).
-- Claimant facts are frozen per submitted revision; entitlement comes from final line decisions only; one
-- approved claim has at most one obligation; confirmed + pending payments never exceed it.
-- Wave 1 records manual payment outcomes; it never transfers money (DF07).

-- Conditional workflow steps (DF06 high-value approver applies only above the threshold).
alter table workflow_step add column condition_code text check (condition_code in ('EXPENSE_HIGH_VALUE'));

create table expense_category (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references company (id) on delete restrict,
  code         text not null check (code ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  name         text not null check (btrim(name) <> ''),
  limit_basis  text not null check (limit_basis in ('PER_DAY', 'PER_NIGHT', 'PER_LINE')),
  active       boolean not null,
  created_at   timestamptz not null default now(),
  created_by   uuid references user_account (id) on delete restrict,
  updated_at   timestamptz not null default now(),
  updated_by   uuid references user_account (id) on delete restrict,
  version      integer not null default 1 check (version > 0),
  unique (company_id, code),
  unique (company_id, id)
);

create table expense_policy (
  id                      uuid primary key default gen_random_uuid(),
  company_id              uuid not null references company (id) on delete restrict,
  code                    text not null check (code ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  revision                integer not null check (revision > 0),
  currency_code           text not null check (currency_code ~ '^[A-Z]{3}$'),
  submission_window_days  integer not null check (submission_window_days > 0),
  high_value_threshold    numeric(19, 4) not null check (high_value_threshold > 0),
  effective_from          date not null,
  effective_to            date check (effective_to > effective_from),
  state                   text not null check (state in ('DRAFT', 'ACTIVE', 'RETIRED')),
  activated_by            uuid references user_account (id) on delete restrict,
  activated_at            timestamptz,
  created_at              timestamptz not null default now(),
  created_by              uuid references user_account (id) on delete restrict,
  updated_at              timestamptz not null default now(),
  updated_by              uuid references user_account (id) on delete restrict,
  version                 integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, code, revision),
  check (state = 'DRAFT' or (activated_by is not null and activated_at is not null)),
  check (activated_by is null or created_by is null or activated_by <> created_by)
);

create table expense_policy_rule (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references company (id) on delete restrict,
  policy_id         uuid not null,
  category_id       uuid not null,
  grade_id          uuid,
  location_id       uuid,
  -- DF06: an unset limit is never "unlimited"; every rule carries an explicit limit.
  limit_amount      numeric(19, 4) not null check (limit_amount > 0),
  receipt_required  boolean not null,
  created_at        timestamptz not null default now(),
  created_by        uuid references user_account (id) on delete restrict,
  updated_at        timestamptz not null default now(),
  updated_by        uuid references user_account (id) on delete restrict,
  version           integer not null default 1 check (version > 0),
  unique (company_id, id),
  foreign key (company_id, policy_id) references expense_policy (company_id, id) on delete restrict,
  foreign key (company_id, category_id) references expense_category (company_id, id) on delete restrict,
  foreign key (company_id, grade_id) references grade (company_id, id) on delete restrict,
  foreign key (company_id, location_id) references location (company_id, id) on delete restrict
);
create unique index expense_policy_rule_uq on expense_policy_rule
  (company_id, policy_id, category_id, coalesce(grade_id, '00000000-0000-0000-0000-000000000000'), coalesce(location_id, '00000000-0000-0000-0000-000000000000'));

-- DB050 expense_claim (typed root of kind expense_claim). payment_state is derived from the ledger.
create table expense_claim (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references company (id) on delete restrict,
  employee_id       uuid not null,
  transaction_kind  text not null default 'expense_claim' check (transaction_kind = 'expense_claim'),
  transaction_id    uuid not null,
  purpose           text not null check (btrim(purpose) <> ''),
  currency_code     text not null check (currency_code ~ '^[A-Z]{3}$'),
  current_revision  integer not null check (current_revision > 0),
  state             text not null check (state in ('DRAFT', 'MANAGER_PENDING', 'FINANCE_PENDING', 'HIGH_VALUE_PENDING', 'RETURNED', 'APPROVED', 'REJECTED', 'WITHDRAWN')),
  payment_state     text not null check (payment_state in ('NOT_APPLICABLE', 'NO_PAYABLE_AMOUNT', 'UNPAID', 'PART_PAID', 'PAID')),
  created_at        timestamptz not null default now(),
  created_by        uuid references user_account (id) on delete restrict,
  updated_at        timestamptz not null default now(),
  updated_by        uuid references user_account (id) on delete restrict,
  version           integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, id, employee_id, currency_code),
  unique (company_id, transaction_id),
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict,
  foreign key (company_id, transaction_kind, transaction_id) references business_transaction (company_id, kind, id) on delete restrict deferrable initially deferred,
  check (state = 'APPROVED' or payment_state = 'NOT_APPLICABLE')
);

create function hrms_expense_claim_mirror() returns trigger language plpgsql as $$
declare
  bt_state text;
begin
  select state into bt_state from business_transaction where company_id = new.company_id and id = new.transaction_id;
  if bt_state is distinct from new.state then
    raise exception 'expense claim state % does not match its transaction state %', new.state, bt_state using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger expense_claim_mirrors_transaction after insert or update on expense_claim deferrable initially deferred
  for each row execute function hrms_expense_claim_mirror();

-- DB051 expense_revision: a submitted revision is frozen (BR-017).
create table expense_revision (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references company (id) on delete restrict,
  claim_id       uuid not null,
  revision       integer not null check (revision > 0),
  policy_id      uuid,
  currency_code  text not null check (currency_code ~ '^[A-Z]{3}$'),
  submitted_at   timestamptz,
  submitted_by   uuid references user_account (id) on delete restrict,
  created_at     timestamptz not null default now(),
  created_by     uuid references user_account (id) on delete restrict,
  updated_at     timestamptz not null default now(),
  updated_by     uuid references user_account (id) on delete restrict,
  version        integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, id, claim_id),
  unique (company_id, claim_id, revision),
  foreign key (company_id, claim_id) references expense_claim (company_id, id) on delete restrict,
  foreign key (company_id, policy_id) references expense_policy (company_id, id) on delete restrict,
  check ((submitted_at is null) = (submitted_by is null)),
  check (submitted_at is null or policy_id is not null)
);

create table expense_line (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references company (id) on delete restrict,
  revision_id        uuid not null,
  sequence           integer not null check (sequence > 0),
  category_id        uuid not null,
  expense_date       date not null,
  nights             integer check (nights > 0),
  merchant           text not null check (btrim(merchant) <> ''),
  invoice_reference  text,
  gross_amount       numeric(19, 4) not null check (gross_amount > 0 and gross_amount = round(gross_amount, 2)),
  claimed_amount     numeric(19, 4) not null check (claimed_amount > 0 and claimed_amount = round(claimed_amount, 2)),
  description        text not null check (btrim(description) <> ''),
  exception_flags    text[] not null default '{}',
  exception_reason   text,
  fingerprint        text not null,
  created_at         timestamptz not null default now(),
  created_by         uuid references user_account (id) on delete restrict,
  updated_at         timestamptz not null default now(),
  updated_by         uuid references user_account (id) on delete restrict,
  version            integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, revision_id, sequence),
  foreign key (company_id, revision_id) references expense_revision (company_id, id) on delete restrict,
  foreign key (company_id, category_id) references expense_category (company_id, id) on delete restrict,
  check (claimed_amount <= gross_amount),
  check (cardinality(exception_flags) = 0 or (exception_reason is not null and btrim(exception_reason) <> ''))
);
create index expense_line_fingerprint_idx on expense_line (company_id, fingerprint);

-- A submitted revision and its lines are immutable (BR-017).
create function hrms_expense_revision_frozen() returns trigger language plpgsql as $$
begin
  if old.submitted_at is not null then
    raise exception 'a submitted expense revision is immutable' using errcode = '23514';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger expense_revision_frozen before update or delete on expense_revision for each row execute function hrms_expense_revision_frozen();

create function hrms_expense_line_frozen() returns trigger language plpgsql as $$
declare
  rev uuid := case when tg_op = 'INSERT' then new.revision_id else old.revision_id end;
  cid uuid := case when tg_op = 'INSERT' then new.company_id else old.company_id end;
begin
  if exists (select 1 from expense_revision where company_id = cid and id = rev and submitted_at is not null) then
    raise exception 'lines of a submitted expense revision are immutable' using errcode = '23514';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger expense_line_frozen before insert or update or delete on expense_line for each row execute function hrms_expense_line_frozen();

create table expense_receipt (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references company (id) on delete restrict,
  line_id        uuid not null,
  attachment_id  uuid not null,
  created_at     timestamptz not null default now(),
  created_by     uuid references user_account (id) on delete restrict,
  updated_at     timestamptz not null default now(),
  updated_by     uuid references user_account (id) on delete restrict,
  version        integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, line_id, attachment_id),
  foreign key (company_id, line_id) references expense_line (company_id, id) on delete restrict,
  foreign key (company_id, attachment_id) references attachment (company_id, id) on delete restrict
);

-- DB054 expense_line_decision: amounts decided by the financial reviewer (CI04 provenance by trigger).
create table expense_line_decision (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references company (id) on delete restrict,
  line_id               uuid not null,
  approval_decision_id  uuid not null,
  allowed_amount        numeric(19, 4) not null check (allowed_amount >= 0 and allowed_amount = round(allowed_amount, 2)),
  exception_reason      text,
  created_at            timestamptz not null default now(),
  created_by            uuid references user_account (id) on delete restrict,
  updated_at            timestamptz not null default now(),
  updated_by            uuid references user_account (id) on delete restrict,
  version               integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, line_id, approval_decision_id),
  foreign key (company_id, line_id) references expense_line (company_id, id) on delete restrict,
  foreign key (company_id, approval_decision_id) references approval_decision (company_id, id) on delete restrict
);

-- CI04: the decision belongs to the approval of the line's own claim and revision; allowed <= claimed;
-- reductions need a reason (FR-073, BR-021).
create function hrms_expense_line_decision_check() returns trigger language plpgsql as $$
declare
  ok boolean;
  claimed numeric;
begin
  select l.claimed_amount,
         exists (select 1 from approval_decision d
                   join approval_task t on t.company_id = d.company_id and t.id = d.task_id
                   join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id
                   join expense_claim c on c.company_id = i.company_id and c.transaction_id = i.transaction_id
                  where d.company_id = new.company_id and d.id = new.approval_decision_id
                    and c.id = r.claim_id and i.transaction_revision = r.revision)
    into claimed, ok
    from expense_line l join expense_revision r on r.company_id = l.company_id and r.id = l.revision_id
   where l.company_id = new.company_id and l.id = new.line_id;
  if not ok then
    raise exception 'line decision does not belong to the approval of its claim revision' using errcode = '23514';
  end if;
  if new.allowed_amount > claimed then
    raise exception 'allowed amount exceeds the claimed amount' using errcode = '23514';
  end if;
  if new.allowed_amount < claimed and (new.exception_reason is null or btrim(new.exception_reason) = '') then
    raise exception 'a reduced or rejected line needs a reason' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger expense_line_decision_check before insert on expense_line_decision for each row execute function hrms_expense_line_decision_check();
create trigger expense_line_decision_append_only before update or delete on expense_line_decision for each row execute function hrms_append_only();

-- DB055 expense_obligation: one per claim (B8 key correction); carries employee and currency for CI05.
create table expense_obligation (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references company (id) on delete restrict,
  claim_id         uuid not null,
  revision_id      uuid not null,
  employee_id      uuid not null,
  approved_amount  numeric(19, 4) not null check (approved_amount > 0),
  currency_code    text not null check (currency_code ~ '^[A-Z]{3}$'),
  approved_by      uuid not null references user_account (id) on delete restrict,
  created_at       timestamptz not null default now(),
  created_by       uuid references user_account (id) on delete restrict,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references user_account (id) on delete restrict,
  version          integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, id, employee_id, currency_code),
  unique (company_id, claim_id),
  foreign key (company_id, claim_id, employee_id, currency_code) references expense_claim (company_id, id, employee_id, currency_code) on delete restrict,
  -- CI03: the revision belongs to the claim.
  foreign key (company_id, revision_id, claim_id) references expense_revision (company_id, id, claim_id) on delete restrict
);
create trigger expense_obligation_append_only before update or delete on expense_obligation for each row execute function hrms_append_only();

-- CI03: obligation amount equals the sum of the final (latest) line decisions of its revision.
create function hrms_expense_obligation_sum() returns trigger language plpgsql as $$
declare
  total numeric;
begin
  select coalesce(sum(x.allowed_amount), 0) into total from (
    select distinct on (d.line_id) d.allowed_amount
      from expense_line_decision d join expense_line l on l.company_id = d.company_id and l.id = d.line_id
     where l.company_id = new.company_id and l.revision_id = new.revision_id
     order by d.line_id, d.created_at desc) x;
  if total <> new.approved_amount then
    raise exception 'obligation % does not equal final line decisions %', new.approved_amount, total using errcode = '23514';
  end if;
  return new;
end $$;
create trigger expense_obligation_sum before insert on expense_obligation for each row execute function hrms_expense_obligation_sum();

-- Payment batch (typed root kind payment_batch), instruction, allocation, outcome events.
create table payment_batch (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references company (id) on delete restrict,
  transaction_kind  text not null default 'payment_batch' check (transaction_kind = 'payment_batch'),
  transaction_id    uuid not null,
  state             text not null check (state in ('READY', 'RELEASED', 'CLOSED')),
  prepared_by       uuid not null references user_account (id) on delete restrict,
  currency_code     text not null check (currency_code ~ '^[A-Z]{3}$'),
  created_at        timestamptz not null default now(),
  created_by        uuid references user_account (id) on delete restrict,
  updated_at        timestamptz not null default now(),
  updated_by        uuid references user_account (id) on delete restrict,
  version           integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, id, currency_code),
  unique (company_id, transaction_id),
  foreign key (company_id, transaction_kind, transaction_id) references business_transaction (company_id, kind, id) on delete restrict deferrable initially deferred
);

create function hrms_payment_batch_mirror() returns trigger language plpgsql as $$
declare
  bt_state text;
begin
  select state into bt_state from business_transaction where company_id = new.company_id and id = new.transaction_id;
  if bt_state is distinct from new.state then
    raise exception 'payment batch state % does not match its transaction state %', new.state, bt_state using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger payment_batch_mirrors_transaction after insert or update on payment_batch deferrable initially deferred
  for each row execute function hrms_payment_batch_mirror();

create table payment_instruction (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references company (id) on delete restrict,
  batch_id         uuid not null,
  employee_id      uuid not null,
  amount           numeric(19, 4) not null check (amount > 0),
  currency_code    text not null check (currency_code ~ '^[A-Z]{3}$'),
  state            text not null check (state in ('PREPARED', 'RELEASED', 'CONFIRMED', 'FAILED', 'CANCELLED')),
  idempotency_key  text not null check (length(idempotency_key) between 8 and 200),
  retry_of_id      uuid,
  payment_date     date not null,
  released_by      uuid references user_account (id) on delete restrict,
  created_at       timestamptz not null default now(),
  created_by       uuid references user_account (id) on delete restrict,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references user_account (id) on delete restrict,
  version          integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, id, employee_id, currency_code),
  unique (company_id, idempotency_key),
  foreign key (company_id, batch_id, currency_code) references payment_batch (company_id, id, currency_code) on delete restrict,
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict,
  foreign key (company_id, retry_of_id) references payment_instruction (company_id, id) on delete restrict,
  check (state not in ('RELEASED', 'CONFIRMED', 'FAILED') or released_by is not null)
);

create table payment_allocation (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references company (id) on delete restrict,
  instruction_id  uuid not null,
  obligation_id   uuid not null,
  employee_id     uuid not null,
  currency_code   text not null,
  amount          numeric(19, 4) not null check (amount > 0),
  created_at      timestamptz not null default now(),
  created_by      uuid references user_account (id) on delete restrict,
  updated_at      timestamptz not null default now(),
  updated_by      uuid references user_account (id) on delete restrict,
  version         integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, instruction_id, obligation_id),
  -- CI05: same employee and currency on both sides.
  foreign key (company_id, instruction_id, employee_id, currency_code) references payment_instruction (company_id, id, employee_id, currency_code) on delete restrict,
  foreign key (company_id, obligation_id, employee_id, currency_code) references expense_obligation (company_id, id, employee_id, currency_code) on delete restrict
);
create trigger payment_allocation_append_only before update or delete on payment_allocation for each row execute function hrms_append_only();

create table payment_event (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references company (id) on delete restrict,
  instruction_id     uuid not null,
  event_key          text not null check (length(event_key) between 4 and 200),
  event_kind         text not null check (event_kind in ('CONFIRMED', 'FAILED', 'REVERSED')),
  amount             numeric(19, 4) not null check (amount > 0),
  occurred_at        timestamptz not null default now(),
  reverses_event_id  uuid,
  recorded_by        uuid not null references user_account (id) on delete restrict,
  reason             text,
  created_at         timestamptz not null default now(),
  created_by         uuid references user_account (id) on delete restrict,
  updated_at         timestamptz not null default now(),
  updated_by         uuid references user_account (id) on delete restrict,
  version            integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, event_key),
  foreign key (company_id, instruction_id) references payment_instruction (company_id, id) on delete restrict,
  foreign key (company_id, reverses_event_id) references payment_event (company_id, id) on delete restrict,
  check ((event_kind = 'REVERSED') = (reverses_event_id is not null)),
  check (event_kind <> 'REVERSED' or (reason is not null and btrim(reason) <> ''))
);
create trigger payment_event_append_only before update or delete on payment_event for each row execute function hrms_append_only();

-- Ledger view per obligation: net confirmed = confirmed - reversed; pending = allocations of live instructions.
create view expense_obligation_ledger as
select o.company_id, o.id as obligation_id, o.claim_id, o.approved_amount, o.currency_code,
       coalesce((select sum(a.amount) from payment_allocation a join payment_instruction i on i.company_id = a.company_id and i.id = a.instruction_id
                  where a.company_id = o.company_id and a.obligation_id = o.id and i.state = 'CONFIRMED'), 0)
       - coalesce((select sum(e.amount) from payment_event e join payment_allocation a on a.company_id = e.company_id and a.instruction_id = e.instruction_id
                    where e.company_id = o.company_id and a.obligation_id = o.id and e.event_kind = 'REVERSED'), 0) as net_paid,
       coalesce((select sum(a.amount) from payment_allocation a join payment_instruction i on i.company_id = a.company_id and i.id = a.instruction_id
                  where a.company_id = o.company_id and a.obligation_id = o.id and i.state in ('PREPARED', 'RELEASED')), 0) as pending
  from expense_obligation o;

-- Conservation (ZT14): confirmed + pending never exceeds the approved obligation.
create function hrms_payment_allocation_conservation() returns trigger language plpgsql as $$
declare
  l record;
begin
  select * into l from expense_obligation_ledger where company_id = new.company_id and obligation_id = new.obligation_id;
  if l.net_paid + l.pending > l.approved_amount then
    raise exception 'payment allocation exceeds the approved obligation' using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger payment_allocation_conservation after insert on payment_allocation deferrable initially deferred
  for each row execute function hrms_payment_allocation_conservation();

-- CI06: a reversal references a confirmation of the same instruction; total reversals <= confirmed amount.
create function hrms_payment_reversal_check() returns trigger language plpgsql as $$
declare
  confirmed numeric;
  reversed numeric;
begin
  if new.event_kind <> 'REVERSED' then
    return new;
  end if;
  if not exists (select 1 from payment_event e where e.company_id = new.company_id and e.id = new.reverses_event_id
                   and e.instruction_id = new.instruction_id and e.event_kind = 'CONFIRMED') then
    raise exception 'a reversal must reference a confirmation of the same instruction' using errcode = '23514';
  end if;
  select coalesce(sum(amount) filter (where event_kind = 'CONFIRMED'), 0), coalesce(sum(amount) filter (where event_kind = 'REVERSED'), 0)
    into confirmed, reversed from payment_event where company_id = new.company_id and instruction_id = new.instruction_id;
  if reversed + new.amount > confirmed then
    raise exception 'reversal exceeds the net confirmed amount' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger payment_reversal_check before insert on payment_event for each row execute function hrms_payment_reversal_check();

insert into transaction_kind (kind, root_table) values ('expense_claim', 'expense_claim'), ('payment_batch', 'payment_batch');
insert into transaction_state (kind, state, initial, terminal) values
  ('expense_claim', 'DRAFT',              true,  false),
  ('expense_claim', 'MANAGER_PENDING',    false, false),
  ('expense_claim', 'FINANCE_PENDING',    false, false),
  ('expense_claim', 'HIGH_VALUE_PENDING', false, false),
  ('expense_claim', 'RETURNED',           false, false),
  ('expense_claim', 'APPROVED',           false, true),
  ('expense_claim', 'REJECTED',           false, true),
  ('expense_claim', 'WITHDRAWN',          false, true),
  ('payment_batch', 'READY',    true,  false),
  ('payment_batch', 'RELEASED', false, false),
  ('payment_batch', 'CLOSED',   false, true);
insert into transaction_transition (kind, from_state, to_state) values
  ('expense_claim', 'DRAFT',              'MANAGER_PENDING'),
  ('expense_claim', 'RETURNED',           'MANAGER_PENDING'),
  ('expense_claim', 'MANAGER_PENDING',    'FINANCE_PENDING'),
  ('expense_claim', 'FINANCE_PENDING',    'HIGH_VALUE_PENDING'),
  ('expense_claim', 'FINANCE_PENDING',    'APPROVED'),
  ('expense_claim', 'HIGH_VALUE_PENDING', 'APPROVED'),
  ('expense_claim', 'MANAGER_PENDING',    'RETURNED'),
  ('expense_claim', 'FINANCE_PENDING',    'RETURNED'),
  ('expense_claim', 'HIGH_VALUE_PENDING', 'RETURNED'),
  ('expense_claim', 'MANAGER_PENDING',    'REJECTED'),
  ('expense_claim', 'FINANCE_PENDING',    'REJECTED'),
  ('expense_claim', 'HIGH_VALUE_PENDING', 'REJECTED'),
  ('expense_claim', 'DRAFT',              'WITHDRAWN'),
  ('expense_claim', 'RETURNED',           'WITHDRAWN'),
  ('payment_batch', 'READY',    'RELEASED'),
  ('payment_batch', 'RELEASED', 'CLOSED');

insert into permission (resource, action, field_group) values
  ('expense', 'draft',             'operational'),
  ('expense', 'submit',            'operational'),
  ('expense', 'withdraw',          'operational'),
  ('expense', 'read',              'operational'),
  ('expense', 'manager_decide',    'operational'),
  ('expense', 'finance_decide',    'operational'),
  ('expense', 'high_value_decide', 'operational'),
  ('expense', 'view_receipt',      'receipt'),
  ('expense_policy', 'manage',   'operational'),
  ('expense_policy', 'activate', 'operational'),
  ('payment', 'read',    'operational'),
  ('payment', 'prepare', 'operational'),
  ('payment', 'release', 'operational'),
  ('payment', 'reverse', 'operational');

do $$
declare
  t text;
begin
  foreach t in array array['expense_category', 'expense_policy', 'expense_policy_rule', 'expense_claim', 'expense_revision', 'expense_line',
                            'expense_receipt', 'payment_batch', 'payment_instruction'] loop
    execute format('create trigger %I before update on %I for each row execute function hrms_touch()', t || '_touch', t);
  end loop;
  foreach t in array array['expense_policy', 'expense_claim', 'payment_batch', 'payment_instruction'] loop
    execute format('create trigger %I before delete on %I for each row execute function hrms_no_delete()', t || '_no_delete', t);
  end loop;
end $$;
