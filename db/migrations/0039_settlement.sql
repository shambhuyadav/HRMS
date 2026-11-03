-- 0039 Full-and-final settlement records (FR-052, FR-053, FR-054; DB079; DB080; F1 "Full-and-final calculation
-- requires actual approved policy/rate packs, independent review and release"; BR-016; DF02; DF03; DF05; DF07; CI14).
--
-- There is no calculation: no approved full-and-final policy or rate pack exists, so calculation_status is fixed at
-- NOT_CONFIGURED and every line is entered or uploaded by an authorised (scoped, granted) HR Administrator.
-- A settlement revision belongs to one exit case and its employee (CI14). Line amounts are signed: earnings are
-- zero or positive, deductions zero or negative, and the net amount equals the sum of the lines (checked at
-- commit). A submitted revision is frozen; a returned or rejected revision is corrected through a new revision
-- that supersedes it. Review and approval are separate independent decisions (separate transactions so that
-- each excludes the preparer and earlier deciders), and release eligibility is a further explicit step that
-- never creates, records or implies a payment.

create table settlement (
  id                              uuid primary key default gen_random_uuid(),
  company_id                      uuid not null references company (id) on delete restrict,
  exit_case_id                    uuid not null,
  employee_id                     uuid not null,
  revision                        integer not null check (revision > 0),
  transaction_kind                text not null default 'settlement' check (transaction_kind = 'settlement'),
  transaction_id                  uuid not null,
  state                           text not null check (state in ('DRAFT', 'SUBMITTED', 'REVIEWED', 'APPROVED', 'RELEASE_ELIGIBLE',
                                                                 'RETURNED', 'REJECTED', 'CANCELLED')),
  currency_code                   text not null check (currency_code ~ '^[A-Z]{3}$'),
  net_amount                      numeric(19, 4) not null default 0,
  calculation_status              text not null default 'NOT_CONFIGURED' check (calculation_status = 'NOT_CONFIGURED'),
  supersedes_settlement_id        uuid,
  prepared_by                     uuid not null references user_account (id) on delete restrict,
  submitted_at                    timestamptz,
  submitted_by                    uuid references user_account (id) on delete restrict,
  reviewed_at                     timestamptz,
  approved_at                     timestamptz,
  closed_at                       timestamptz,
  release_eligible_at             timestamptz,
  release_eligible_by             uuid references user_account (id) on delete restrict,
  release_eligible_assignment_id  uuid,
  created_at                      timestamptz not null default now(),
  created_by                      uuid references user_account (id) on delete restrict,
  updated_at                      timestamptz not null default now(),
  updated_by                      uuid references user_account (id) on delete restrict,
  version                         integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, id, employee_id),
  unique (company_id, id, exit_case_id),
  unique (company_id, exit_case_id, revision),
  unique (company_id, transaction_id),
  -- CI14: the settlement employee resolves through the same exit case.
  foreign key (company_id, exit_case_id, employee_id) references exit_case (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, transaction_kind, transaction_id) references business_transaction (company_id, kind, id)
    on delete restrict deferrable initially deferred,
  foreign key (company_id, supersedes_settlement_id, exit_case_id) references settlement (company_id, id, exit_case_id) on delete restrict,
  foreign key (company_id, release_eligible_assignment_id) references role_assignment (company_id, id) on delete restrict,
  check (supersedes_settlement_id is distinct from id),
  check ((revision = 1) = (supersedes_settlement_id is null)),
  check (state = 'DRAFT' or state = 'CANCELLED' or (submitted_at is not null and submitted_by is not null)),
  check (state not in ('REVIEWED', 'APPROVED', 'RELEASE_ELIGIBLE') or reviewed_at is not null),
  check (state not in ('APPROVED', 'RELEASE_ELIGIBLE') or approved_at is not null),
  check ((state in ('RETURNED', 'REJECTED', 'CANCELLED')) = (closed_at is not null)),
  check ((state = 'RELEASE_ELIGIBLE') = (release_eligible_at is not null)),
  check ((release_eligible_at is null) = (release_eligible_by is null) and (release_eligible_at is null) = (release_eligible_assignment_id is null))
);
-- One live revision per exit; a revision is superseded by at most one successor.
create unique index settlement_one_live on settlement (company_id, exit_case_id)
  where (state in ('DRAFT', 'SUBMITTED', 'REVIEWED', 'APPROVED', 'RELEASE_ELIGIBLE'));
create unique index settlement_one_successor on settlement (company_id, supersedes_settlement_id) where (supersedes_settlement_id is not null);

create function hrms_settlement_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.state <> 'DRAFT' or new.net_amount <> 0 then
      raise exception 'a settlement revision starts as an empty draft' using errcode = '23514';
    end if;
    if new.revision <> coalesce((select max(revision) from settlement where company_id = new.company_id and exit_case_id = new.exit_case_id), 0) + 1 then
      raise exception 'settlement revisions of an exit are consecutive' using errcode = '23514';
    end if;
    return new;
  end if;
  if (new.exit_case_id, new.employee_id, new.revision, new.transaction_id, new.supersedes_settlement_id, new.prepared_by, new.currency_code, new.calculation_status)
     is distinct from (old.exit_case_id, old.employee_id, old.revision, old.transaction_id, old.supersedes_settlement_id, old.prepared_by, old.currency_code, old.calculation_status) then
    raise exception 'settlement identity is immutable' using errcode = '23514';
  end if;
  if old.state <> 'DRAFT' and new.net_amount is distinct from old.net_amount then
    raise exception 'a submitted settlement revision is frozen' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger settlement_guard before insert or update on settlement for each row execute function hrms_settlement_guard();

-- DB080 settlement_line: one line per component (grouped model). Lines change only while the revision is a draft.
create table settlement_line (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references company (id) on delete restrict,
  settlement_id uuid not null,
  component_id  uuid not null,
  amount        numeric(19, 4) not null check (amount between -999999999999999.9999 and 999999999999999.9999),
  -- A monetary notice adjustment needs the exit's recorded contractual notice period (F1).
  line_kind     text not null default 'STANDARD' check (line_kind in ('STANDARD', 'NOTICE_ADJUSTMENT')),
  source        text not null check (source in ('ENTERED', 'UPLOADED', 'COPIED')),
  created_at    timestamptz not null default now(),
  created_by    uuid references user_account (id) on delete restrict,
  updated_at    timestamptz not null default now(),
  updated_by    uuid references user_account (id) on delete restrict,
  version       integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, settlement_id, component_id),
  foreign key (company_id, settlement_id) references settlement (company_id, id) on delete restrict,
  foreign key (company_id, component_id) references pay_component (company_id, id) on delete restrict
);

create function hrms_settlement_line_guard() returns trigger language plpgsql as $$
declare
  s_state text;
  s_exit uuid;
  c_kind text;
  c_active boolean;
  notice integer;
begin
  select state, exit_case_id into s_state, s_exit from settlement
   where company_id = coalesce(new.company_id, old.company_id) and id = coalesce(new.settlement_id, old.settlement_id);
  if s_state is distinct from 'DRAFT' then
    raise exception 'lines of a submitted settlement revision are frozen' using errcode = '23514';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  if tg_op = 'UPDATE' and (new.settlement_id, new.component_id) is distinct from (old.settlement_id, old.component_id) then
    raise exception 'a settlement line identity is immutable' using errcode = '23514';
  end if;
  select component_kind, active into c_kind, c_active from pay_component where company_id = new.company_id and id = new.component_id;
  if tg_op = 'INSERT' and c_active is not true then
    raise exception 'the pay component is not active' using errcode = '23514';
  end if;
  -- Sign convention (owner approval pending, DB080): earnings >= 0, deductions <= 0, net = sum of lines.
  if (c_kind = 'EARNING' and new.amount < 0) or (c_kind = 'DEDUCTION' and new.amount > 0) then
    raise exception 'the amount sign must follow the component kind' using errcode = '23514';
  end if;
  if new.line_kind = 'NOTICE_ADJUSTMENT' then
    select contractual_notice_days into notice from exit_case where company_id = new.company_id and id = s_exit;
    if notice is null then
      raise exception 'a notice adjustment needs the recorded contractual notice period' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger settlement_line_guard before insert or update or delete on settlement_line
  for each row execute function hrms_settlement_line_guard();

-- The net amount equals the sum of the lines whenever a transaction commits (no amounts in the message).
create function hrms_settlement_net_check() returns trigger language plpgsql as $$
declare
  cid uuid;
  sid uuid;
  stored numeric;
  summed numeric;
begin
  if tg_table_name = 'settlement' then
    cid := new.company_id;
    sid := new.id;
  elsif tg_op = 'DELETE' then
    cid := old.company_id;
    sid := old.settlement_id;
  else
    cid := new.company_id;
    sid := new.settlement_id;
  end if;
  select net_amount into stored from settlement where company_id = cid and id = sid;
  select coalesce(sum(amount), 0) into summed from settlement_line where company_id = cid and settlement_id = sid;
  if stored is not null and stored <> summed then
    raise exception 'a settlement net amount must equal the sum of its lines' using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger settlement_net_matches_lines after insert or update on settlement deferrable initially deferred
  for each row execute function hrms_settlement_net_check();
create constraint trigger settlement_line_net_matches after insert or update or delete on settlement_line deferrable initially deferred
  for each row execute function hrms_settlement_net_check();

-- The approval stage of a reviewed revision: its own transaction, so that the approver is selected independently of
-- the preparer and the reviewer (DF02/DF03 preparer differs from approver).
create table settlement_approval (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references company (id) on delete restrict,
  settlement_id     uuid not null,
  employee_id       uuid not null,
  transaction_kind  text not null default 'settlement_approval' check (transaction_kind = 'settlement_approval'),
  transaction_id    uuid not null,
  state             text not null check (state in ('SUBMITTED', 'APPROVED', 'REJECTED', 'RETURNED')),
  decided_at        timestamptz,
  created_at        timestamptz not null default now(),
  created_by        uuid references user_account (id) on delete restrict,
  updated_at        timestamptz not null default now(),
  updated_by        uuid references user_account (id) on delete restrict,
  version           integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, transaction_id),
  unique (company_id, settlement_id),
  foreign key (company_id, settlement_id, employee_id) references settlement (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, transaction_kind, transaction_id) references business_transaction (company_id, kind, id)
    on delete restrict deferrable initially deferred,
  check ((state = 'SUBMITTED') = (decided_at is null))
);

create function hrms_settlement_approval_guard() returns trigger language plpgsql as $$
begin
  if (new.settlement_id, new.employee_id, new.transaction_id) is distinct from (old.settlement_id, old.employee_id, old.transaction_id) then
    raise exception 'a settlement approval stage identity is immutable' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger settlement_approval_guard before update on settlement_approval for each row execute function hrms_settlement_approval_guard();

do $$
declare
  t text;
begin
  foreach t in array array['settlement', 'settlement_approval'] loop
    execute format('create constraint trigger %I after insert or update on %I deferrable initially deferred for each row execute function hrms_lifecycle_mirror()',
                   t || '_mirrors_transaction', t);
    execute format('create trigger %I before delete on %I for each row execute function hrms_no_delete()', t || '_no_delete', t);
  end loop;
  foreach t in array array['settlement', 'settlement_line', 'settlement_approval'] loop
    execute format('create trigger %I before update on %I for each row execute function hrms_touch()', t || '_touch', t);
  end loop;
end $$;

insert into transaction_kind (kind, root_table, routing_kind) values ('settlement', 'settlement', null);
-- The approval stage uses the settlement list of HR reviewers.
insert into transaction_kind (kind, root_table, routing_kind) values ('settlement_approval', 'settlement_approval', 'settlement');
insert into transaction_state (kind, state, initial, terminal) values
  ('settlement', 'DRAFT',            true,  false),
  ('settlement', 'SUBMITTED',        false, false),
  ('settlement', 'REVIEWED',         false, false),
  ('settlement', 'APPROVED',         false, false),
  ('settlement', 'RELEASE_ELIGIBLE', false, true),
  ('settlement', 'RETURNED',         false, true),
  ('settlement', 'REJECTED',         false, true),
  ('settlement', 'CANCELLED',        false, true),
  ('settlement_approval', 'SUBMITTED', true,  false),
  ('settlement_approval', 'APPROVED',  false, true),
  ('settlement_approval', 'REJECTED',  false, true),
  ('settlement_approval', 'RETURNED',  false, true);
insert into transaction_transition (kind, from_state, to_state) values
  ('settlement', 'DRAFT',     'SUBMITTED'),
  ('settlement', 'DRAFT',     'CANCELLED'),
  ('settlement', 'SUBMITTED', 'REVIEWED'),
  ('settlement', 'SUBMITTED', 'RETURNED'),
  ('settlement', 'SUBMITTED', 'REJECTED'),
  ('settlement', 'REVIEWED',  'APPROVED'),
  ('settlement', 'REVIEWED',  'RETURNED'),
  ('settlement', 'REVIEWED',  'REJECTED'),
  ('settlement', 'APPROVED',  'RELEASE_ELIGIBLE'),
  ('settlement_approval', 'SUBMITTED', 'APPROVED'),
  ('settlement_approval', 'SUBMITTED', 'REJECTED'),
  ('settlement_approval', 'SUBMITTED', 'RETURNED');

-- Amounts are confidential (DF02: compensation amounts and payroll totals); only the state, revision, currency and
-- calculation status are operational. Every amount duty is an eligible HR Administrator grant (ceiling only).
insert into permission (resource, action, field_group, own_ess) values
  ('settlement', 'read',    'operational', false),
  ('settlement', 'read',    'amount',      false),
  ('settlement', 'prepare', 'amount',      false),
  ('settlement', 'review',  'amount',      false),
  ('settlement', 'approve', 'amount',      false),
  ('settlement', 'release', 'amount',      false);
