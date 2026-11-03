-- 0045 Payroll outputs on top of the payroll core (0043): bank files and the salary payment ledger (FR-102; DB112,
-- DB113, DB114, DB118; H2 payment states; BR-052; CI27; CI28; DF07 outcome-ledger rules), issued payslips (FR-107;
-- DB117; CI30). Loans and advances (FR-034) are in 0046; tax declarations and investment proofs (FR-036; FR-108) are
-- not built (they need an active tax rule pack).
--
-- Payment ledger. A bank line (DB114) is one salary payment allocation of a processed payroll record in one manifest
-- (DB113), with a company-wide unique allocation key. Its payment state moves only through append-only payment events
-- (DB118): READY (validated manifest, nothing reserved) -> RESERVED (independent authorisation) -> SUBMITTED / UNKNOWN
-- -> CONFIRMED / FAILED / CANCELLED, and CONFIRMED -> REVERSED (bounded by the unreversed confirmation). Pending
-- reservations (RESERVED, SUBMITTED, UNKNOWN) plus net confirmed payments plus live holds never exceed the record's
-- payable net (the core's capacity check is extended below); a definitive FAILED or CANCELLED outcome frees the
-- reservation, UNKNOWN does not. Generating or downloading a file never changes a payment state, and nothing is ever
-- marked paid except by a recorded CONFIRMED outcome with its evidence.
--
-- Bank file templates (DB112) are company configuration only: no bank format is presumed. A template revision holds
-- an exact ordered field mapping from the bank-accepted specification; it activates only with that specification's
-- reference and an independent sample validation (someone other than its author records the bank's acceptance of the
-- system-generated sample, bound to the sample's hash). A synthetic test-only template is refused activation in
-- production by the service.
--
-- Issued outputs (DB117). A payslip is published from a PROCESSED_LOCKED record by an authorised publisher, with a
-- version and the SHA-256 of the exact stored file, which is a confidential system-generated attachment served only
-- through this module's routes (never through the general document routes, CI30). Replacements keep the earlier
-- issue as SUPERSEDED. Form 16 needs the applicable statutory template, which does not exist: it cannot be issued.

-- ---------------------------------------------------------------------------------------------------------------
-- DB112 bank file template revisions
-- ---------------------------------------------------------------------------------------------------------------
create table payroll_bank_template (
  id                            uuid primary key default gen_random_uuid(),
  company_id                    uuid not null references company (id) on delete restrict,
  template_code                 text not null check (template_code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  template_version              integer not null check (template_version > 0),
  name                          text not null check (btrim(name) <> '' and length(name) <= 200),
  currency_code                 text not null check (currency_code ~ '^[A-Z]{3}$'),
  format_definition             jsonb not null,
  definition_hash               text not null check (definition_hash ~ '^[0-9a-f]{64}$'),
  bank_specification_reference  text not null check (btrim(bank_specification_reference) <> '' and length(bank_specification_reference) <= 500),
  test_only                     boolean not null,
  state                         text not null default 'DRAFT' check (state in ('DRAFT', 'ACTIVE', 'RETIRED', 'CANCELLED')),
  sample_hash                   text check (sample_hash ~ '^[0-9a-f]{64}$'),
  sample_validation_reference   text check (sample_validation_reference is null or (btrim(sample_validation_reference) <> '' and length(sample_validation_reference) <= 500)),
  sample_validated_by           uuid references user_account (id) on delete restrict,
  sample_validated_at           timestamptz,
  activated_by                  uuid references user_account (id) on delete restrict,
  activated_at                  timestamptz,
  closed_by                     uuid references user_account (id) on delete restrict,
  closed_at                     timestamptz,
  close_reason                  text check (close_reason is null or (btrim(close_reason) <> '' and length(close_reason) <= 1000)),
  created_at                    timestamptz not null default now(),
  created_by                    uuid not null references user_account (id) on delete restrict,
  updated_at                    timestamptz not null default now(),
  updated_by                    uuid references user_account (id) on delete restrict,
  version                       integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, template_code, template_version),
  check ((sample_hash is null) = (sample_validated_by is null) and (sample_hash is null) = (sample_validated_at is null)
         and (sample_hash is null) = (sample_validation_reference is null)),
  -- Independent sample validation and activation (never the author).
  check (sample_validated_by is null or sample_validated_by <> created_by),
  check (activated_by is null or activated_by <> created_by),
  check ((activated_at is null) = (activated_by is null)),
  check (state not in ('ACTIVE', 'RETIRED') or (activated_at is not null and sample_hash is not null)),
  check (state <> 'DRAFT' or activated_at is null),
  check ((state in ('RETIRED', 'CANCELLED')) = (closed_at is not null)),
  check ((closed_at is null) = (closed_by is null) and (closed_at is null) = (close_reason is null))
);
create unique index payroll_bank_template_one_active on payroll_bank_template (company_id, template_code) where (state = 'ACTIVE');

create function hrms_payroll_bank_template_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.state <> 'DRAFT' or new.sample_hash is not null then
      raise exception 'a bank file template revision starts as an unvalidated draft' using errcode = '23514';
    end if;
    return new;
  end if;
  if (new.template_code, new.template_version, new.name, new.currency_code, new.format_definition, new.definition_hash,
      new.bank_specification_reference, new.test_only)
     is distinct from (old.template_code, old.template_version, old.name, old.currency_code, old.format_definition, old.definition_hash,
      old.bank_specification_reference, old.test_only) then
    raise exception 'a bank file template revision never changes; create a new version' using errcode = '23514';
  end if;
  if old.sample_hash is not null and (new.sample_hash, new.sample_validation_reference, new.sample_validated_by, new.sample_validated_at)
     is distinct from (old.sample_hash, old.sample_validation_reference, old.sample_validated_by, old.sample_validated_at) then
    raise exception 'a sample validation is recorded once' using errcode = '23514';
  end if;
  if old.state <> 'DRAFT' and new.sample_hash is distinct from old.sample_hash then
    raise exception 'a sample is validated on a draft only' using errcode = '23514';
  end if;
  if new.state is distinct from old.state and not (
       (old.state = 'DRAFT' and new.state in ('ACTIVE', 'CANCELLED')) or (old.state = 'ACTIVE' and new.state = 'RETIRED')) then
    raise exception 'invalid bank file template transition % -> %', old.state, new.state using errcode = '23514';
  end if;
  return new;
end $$;
create trigger payroll_bank_template_guard before insert or update on payroll_bank_template for each row execute function hrms_payroll_bank_template_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- DB113 bank manifests (batches). States: VALIDATED (final manifest prepared, every row validated, totals
-- reconciled; nothing reserved) -> AUTHORIZED (independent authorisation: lines RESERVED) -> ISSUED (restricted file
-- generated once; its content never changes); CANCELLED only before authorisation. The non-payable draft preview is
-- computed on request and never stored.
-- ---------------------------------------------------------------------------------------------------------------
create table payroll_bank_batch (
  id                        uuid primary key default gen_random_uuid(),
  company_id                uuid not null references company (id) on delete restrict,
  run_id                    uuid not null,
  template_id               uuid not null,
  batch_revision            integer not null check (batch_revision > 0),
  supersedes_batch_id       uuid,
  currency_code             text not null check (currency_code ~ '^[A-Z]{3}$'),
  payment_date              date not null,
  state                     text not null check (state in ('VALIDATED', 'AUTHORIZED', 'ISSUED', 'CANCELLED')),
  line_count                integer not null check (line_count > 0),
  total_amount              numeric(19, 4) not null check (total_amount > 0),
  manifest_hash             text not null check (manifest_hash ~ '^[0-9a-f]{64}$'),
  -- Counts of records left out and why (held, already reserved or paid, nothing payable, excluded by the preparer),
  -- and the employee codes the preparer excluded: operational facts, no amounts.
  excluded_summary          jsonb not null default '{}'::jsonb,
  exclusion_reason          text check (exclusion_reason is null or (btrim(exclusion_reason) <> '' and length(exclusion_reason) <= 1000)),
  prepared_by               uuid not null references user_account (id) on delete restrict,
  prepared_assignment_id    uuid,
  prepared_at               timestamptz not null default now(),
  authorized_by             uuid references user_account (id) on delete restrict,
  authorized_assignment_id  uuid,
  authorized_at             timestamptz,
  content_hash              text check (content_hash ~ '^[0-9a-f]{64}$'),
  file_attachment_id        uuid,
  file_name                 text check (file_name is null or (btrim(file_name) <> '' and length(file_name) <= 255)),
  issued_by                 uuid references user_account (id) on delete restrict,
  issued_at                 timestamptz,
  cancelled_by              uuid references user_account (id) on delete restrict,
  cancelled_at              timestamptz,
  cancel_reason             text check (cancel_reason is null or (btrim(cancel_reason) <> '' and length(cancel_reason) <= 1000)),
  created_at                timestamptz not null default now(),
  created_by                uuid references user_account (id) on delete restrict,
  updated_at                timestamptz not null default now(),
  updated_by                uuid references user_account (id) on delete restrict,
  version                   integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, id, run_id),
  unique (company_id, run_id, template_id, batch_revision),
  foreign key (company_id, run_id) references payroll_run (company_id, id) on delete restrict,
  foreign key (company_id, template_id) references payroll_bank_template (company_id, id) on delete restrict,
  -- A replacement references an earlier manifest of the same run (set once at creation, so never a cycle).
  foreign key (company_id, supersedes_batch_id, run_id) references payroll_bank_batch (company_id, id, run_id) on delete restrict,
  foreign key (company_id, file_attachment_id) references attachment (company_id, id) on delete restrict,
  foreign key (company_id, prepared_assignment_id) references role_assignment (company_id, id) on delete restrict,
  foreign key (company_id, authorized_assignment_id) references role_assignment (company_id, id) on delete restrict,
  check (supersedes_batch_id is null or supersedes_batch_id <> id),
  -- C4 / H2: preparation and authorisation actors differ.
  check (authorized_by is null or authorized_by <> prepared_by),
  check ((authorized_at is null) = (authorized_by is null)),
  check ((state in ('AUTHORIZED', 'ISSUED')) = (authorized_at is not null)),
  check ((state = 'ISSUED') = (issued_at is not null)),
  check ((issued_at is null) = (issued_by is null) and (issued_at is null) = (content_hash is null)
         and (issued_at is null) = (file_attachment_id is null) and (issued_at is null) = (file_name is null)),
  check ((state = 'CANCELLED') = (cancelled_at is not null)),
  check ((cancelled_at is null) = (cancelled_by is null) and (cancelled_at is null) = (cancel_reason is null))
);
-- One manifest at a time awaits authorisation per run (prepared lines are not reserved yet, so two open manifests
-- could otherwise both claim the same payable amounts).
create unique index payroll_bank_batch_one_open on payroll_bank_batch (company_id, run_id) where (state = 'VALIDATED');

create function hrms_payroll_bank_batch_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.state <> 'VALIDATED' then
      raise exception 'a bank manifest starts validated' using errcode = '23514';
    end if;
    return new;
  end if;
  if (new.run_id, new.template_id, new.batch_revision, new.supersedes_batch_id, new.currency_code, new.payment_date, new.line_count,
      new.total_amount, new.manifest_hash, new.excluded_summary, new.exclusion_reason, new.prepared_by, new.prepared_assignment_id, new.prepared_at)
     is distinct from (old.run_id, old.template_id, old.batch_revision, old.supersedes_batch_id, old.currency_code, old.payment_date, old.line_count,
      old.total_amount, old.manifest_hash, old.excluded_summary, old.exclusion_reason, old.prepared_by, old.prepared_assignment_id, old.prepared_at) then
    raise exception 'a prepared bank manifest never changes' using errcode = '23514';
  end if;
  if old.issued_at is not null and (new.content_hash, new.file_attachment_id, new.file_name, new.issued_by, new.issued_at)
     is distinct from (old.content_hash, old.file_attachment_id, old.file_name, old.issued_by, old.issued_at) then
    raise exception 'issued bank file content is immutable' using errcode = '23514';
  end if;
  if old.authorized_at is not null and (new.authorized_by, new.authorized_at, new.authorized_assignment_id)
     is distinct from (old.authorized_by, old.authorized_at, old.authorized_assignment_id) then
    raise exception 'a manifest authorisation is recorded once' using errcode = '23514';
  end if;
  if new.state is distinct from old.state and not (
       (old.state = 'VALIDATED' and new.state in ('AUTHORIZED', 'CANCELLED')) or (old.state = 'AUTHORIZED' and new.state = 'ISSUED')) then
    raise exception 'invalid bank manifest transition % -> %', old.state, new.state using errcode = '23514';
  end if;
  return new;
end $$;
create trigger payroll_bank_batch_guard before insert or update on payroll_bank_batch for each row execute function hrms_payroll_bank_batch_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- DB114 bank lines: one payment allocation each. hold_id links an allocation that pays a released hold's amount
-- (H2: a release creates a new allocation for the outstanding held liability). The bank revision is the approved
-- instruction frozen by processing, or the one the release of a payment safety block verified.
-- ---------------------------------------------------------------------------------------------------------------
create table payroll_bank_line (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references company (id) on delete restrict,
  batch_id             uuid not null,
  run_id               uuid not null,
  line_sequence        integer not null check (line_sequence > 0),
  allocation_key       text not null check (allocation_key ~ '^(PAY|REL)-[0-9a-f-]{36}-[0-9]{1,6}$'),
  payroll_record_id    uuid not null,
  employee_id          uuid not null,
  hold_id              uuid,
  bank_revision_id     uuid not null,
  payable_amount       numeric(19, 4) not null check (payable_amount > 0),
  currency_code        text not null check (currency_code ~ '^[A-Z]{3}$'),
  payment_state        text not null default 'READY'
                       check (payment_state in ('READY', 'RESERVED', 'SUBMITTED', 'UNKNOWN', 'CONFIRMED', 'FAILED', 'CANCELLED', 'REVERSED')),
  confirmed_amount     numeric(19, 4) not null default 0 check (confirmed_amount >= 0),
  reversed_amount      numeric(19, 4) not null default 0 check (reversed_amount >= 0),
  last_event_sequence  integer not null default 0 check (last_event_sequence >= 0),
  created_at           timestamptz not null default now(),
  created_by           uuid references user_account (id) on delete restrict,
  updated_at           timestamptz not null default now(),
  updated_by           uuid references user_account (id) on delete restrict,
  version              integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, batch_id, line_sequence),
  -- Company-wide allocation keys bind one logical instruction (H5).
  unique (company_id, allocation_key),
  foreign key (company_id, batch_id, run_id) references payroll_bank_batch (company_id, id, run_id) on delete restrict,
  foreign key (company_id, payroll_record_id, run_id) references payroll_record (company_id, id, run_id) on delete restrict,
  foreign key (company_id, payroll_record_id, employee_id) references payroll_record (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, hold_id, employee_id) references payroll_hold (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, bank_revision_id) references employee_private_profile_revision (company_id, id) on delete restrict,
  check (confirmed_amount = 0 or confirmed_amount = payable_amount),
  check ((payment_state in ('CONFIRMED', 'REVERSED')) = (confirmed_amount > 0)),
  check (reversed_amount <= confirmed_amount),
  check (payment_state <> 'REVERSED' or reversed_amount = confirmed_amount),
  check ((allocation_key like 'REL-%') = (hold_id is not null))
);
create index payroll_bank_line_record_idx on payroll_bank_line (company_id, payroll_record_id);
create index payroll_bank_line_hold_idx on payroll_bank_line (company_id, hold_id) where (hold_id is not null);
create index payroll_bank_line_employee_idx on payroll_bank_line (company_id, employee_id);

create function hrms_payroll_bank_line_guard() returns trigger language plpgsql as $$
declare
  batch_state text;
  run_state text;
  frozen timestamptz;
  rev_employee uuid;
  rev_category text;
  hold_state text;
  hold_record uuid;
begin
  if tg_op = 'INSERT' then
    select state into batch_state from payroll_bank_batch where company_id = new.company_id and id = new.batch_id;
    select ru.state, r.frozen_at into run_state, frozen
      from payroll_record r join payroll_run ru on ru.company_id = r.company_id and ru.id = r.run_id
     where r.company_id = new.company_id and r.id = new.payroll_record_id;
    select employee_id, category into rev_employee, rev_category from employee_private_profile_revision where company_id = new.company_id and id = new.bank_revision_id;
    if batch_state is distinct from 'VALIDATED' or new.payment_state <> 'READY' or new.confirmed_amount <> 0 or new.reversed_amount <> 0 or new.last_event_sequence <> 0 then
      raise exception 'bank lines are written once, ready, into a validated manifest' using errcode = '23514';
    end if;
    if run_state is distinct from 'PROCESSED_LOCKED' or frozen is null then
      raise exception 'a bank line pays a frozen record of a processed run only' using errcode = '23514';
    end if;
    if rev_employee is distinct from new.employee_id or rev_category is distinct from 'BANK' then
      raise exception 'a bank line references an approved bank revision of the same employee' using errcode = '23514';
    end if;
    if new.hold_id is not null then
      select state, payroll_record_id into hold_state, hold_record from payroll_hold where company_id = new.company_id and id = new.hold_id;
      if hold_state is distinct from 'RELEASED' or hold_record is distinct from new.payroll_record_id then
        raise exception 'a held allocation is never included before its approved release' using errcode = '23514';
      end if;
    end if;
    return new;
  end if;
  if (new.batch_id, new.run_id, new.line_sequence, new.allocation_key, new.payroll_record_id, new.employee_id, new.hold_id, new.bank_revision_id,
      new.payable_amount, new.currency_code)
     is distinct from (old.batch_id, old.run_id, old.line_sequence, old.allocation_key, old.payroll_record_id, old.employee_id, old.hold_id, old.bank_revision_id,
      old.payable_amount, old.currency_code) then
    raise exception 'a bank line never changes' using errcode = '23514';
  end if;
  if (new.payment_state, new.confirmed_amount, new.reversed_amount, new.last_event_sequence)
     is distinct from (old.payment_state, old.confirmed_amount, old.reversed_amount, old.last_event_sequence) then
    -- The ledger moves only through payment events (written by the event trigger), except that an unreserved line
    -- of a manifest cancelled before authorisation is cancelled with it.
    select state into batch_state from payroll_bank_batch where company_id = new.company_id and id = new.batch_id;
    if not (pg_trigger_depth() > 1
            or (old.payment_state = 'READY' and new.payment_state = 'CANCELLED' and batch_state = 'CANCELLED'
                and new.last_event_sequence = 0 and new.confirmed_amount = 0 and new.reversed_amount = 0)) then
      raise exception 'payment states change only through recorded payment events' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger payroll_bank_line_guard before insert or update on payroll_bank_line for each row execute function hrms_payroll_bank_line_guard();

-- CI28 reconciliation at commit: a manifest's count and control total equal its lines, all in its currency.
create function hrms_payroll_bank_batch_totals() returns trigger language plpgsql as $$
declare
  bid uuid;
  b payroll_bank_batch%rowtype;
  n integer;
  total numeric;
  other_currency integer;
begin
  bid := (to_jsonb(new) ->> case when tg_table_name = 'payroll_bank_batch' then 'id' else 'batch_id' end)::uuid;
  select * into b from payroll_bank_batch where company_id = new.company_id and id = bid;
  select count(*), coalesce(sum(payable_amount), 0), count(*) filter (where currency_code <> b.currency_code)
    into n, total, other_currency
    from payroll_bank_line where company_id = new.company_id and batch_id = bid;
  if n <> b.line_count or total <> b.total_amount or other_currency > 0 then
    raise exception 'a bank manifest''s count, currency and control total must equal its lines' using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger payroll_bank_batch_totals_match after insert on payroll_bank_batch deferrable initially deferred
  for each row execute function hrms_payroll_bank_batch_totals();
create constraint trigger payroll_bank_line_totals_match after insert on payroll_bank_line deferrable initially deferred
  for each row execute function hrms_payroll_bank_batch_totals();

-- ---------------------------------------------------------------------------------------------------------------
-- DB118 payroll payment events (append-only). Separate from the expense outcome tables (H5).
-- ---------------------------------------------------------------------------------------------------------------
create table payroll_payment_event (
  id                      uuid primary key default gen_random_uuid(),
  company_id              uuid not null references company (id) on delete restrict,
  bank_line_id            uuid not null,
  sequence                integer not null check (sequence > 0),
  event_kind              text not null check (event_kind in ('RESERVED', 'SUBMITTED', 'UNKNOWN', 'CONFIRMED', 'FAILED', 'CANCELLED', 'REVERSED')),
  -- Idempotent evidence key: the same evidence never records a second outcome (DF07).
  event_key               text not null check (event_key ~ '^[A-Za-z0-9._:-]{8,100}$'),
  amount                  numeric(19, 4) not null check (amount > 0),
  currency_code           text not null check (currency_code ~ '^[A-Z]{3}$'),
  event_time              timestamptz not null,
  evidence_reference      text not null check (btrim(evidence_reference) <> '' and length(evidence_reference) <= 500),
  reverses_event_id       uuid,
  reason                  text check (reason is null or (btrim(reason) <> '' and length(reason) <= 1000)),
  recorded_by             uuid not null references user_account (id) on delete restrict,
  recorded_assignment_id  uuid,
  created_at              timestamptz not null default now(),
  created_by              uuid references user_account (id) on delete restrict,
  unique (company_id, id),
  unique (company_id, event_key),
  unique (company_id, bank_line_id, sequence),
  foreign key (company_id, bank_line_id) references payroll_bank_line (company_id, id) on delete restrict,
  foreign key (company_id, reverses_event_id) references payroll_payment_event (company_id, id) on delete restrict,
  foreign key (company_id, recorded_assignment_id) references role_assignment (company_id, id) on delete restrict,
  check ((event_kind = 'REVERSED') = (reverses_event_id is not null)),
  check (event_kind <> 'REVERSED' or reason is not null)
);
create index payroll_payment_event_line_idx on payroll_payment_event (company_id, bank_line_id);

-- Validates each event against the line's current state (sequence, currency, amount, transition, reversal bounds)
-- and moves the line's ledger state with it, in the same statement.
create function hrms_payroll_payment_event_apply() returns trigger language plpgsql as $$
declare
  l payroll_bank_line%rowtype;
  rev payroll_payment_event%rowtype;
  next_state text;
  next_confirmed numeric;
  next_reversed numeric;
  b_state text;
  b_prepared uuid;
begin
  select * into l from payroll_bank_line where company_id = new.company_id and id = new.bank_line_id for update;
  if not found then
    raise exception 'unknown bank line' using errcode = '23503';
  end if;
  select state, prepared_by into b_state, b_prepared from payroll_bank_batch where company_id = new.company_id and id = l.batch_id;
  -- C4 / H2: the preparer of a manifest never reserves, confirms, fails, cancels or reverses its allocations.
  if new.recorded_by = b_prepared then
    raise exception 'the preparer of a bank manifest never records its payment events' using errcode = '23514';
  end if;
  -- A reservation is made only by the authorisation of a prepared manifest; outcomes only on an authorised manifest,
  -- and anything but a cancellation only once its file has been issued (DF07: nothing is paid by a file that was never
  -- generated).
  if (new.event_kind = 'RESERVED' and b_state is distinct from 'VALIDATED')
     or (new.event_kind <> 'RESERVED' and b_state not in ('AUTHORIZED', 'ISSUED'))
     or (new.event_kind in ('SUBMITTED', 'UNKNOWN', 'CONFIRMED', 'FAILED', 'REVERSED') and b_state <> 'ISSUED') then
    raise exception 'a % payment event does not fit a % bank manifest', new.event_kind, b_state using errcode = '23514';
  end if;
  if new.sequence <> l.last_event_sequence + 1 then
    raise exception 'payment events of a line are recorded in sequence' using errcode = '23514';
  end if;
  if new.currency_code <> l.currency_code then
    raise exception 'a payment event has the currency of its line' using errcode = '23514';
  end if;
  next_confirmed := l.confirmed_amount;
  next_reversed := l.reversed_amount;
  if new.event_kind = 'REVERSED' then
    if l.payment_state <> 'CONFIRMED' then
      raise exception 'only a confirmed payment can be reversed' using errcode = '23514';
    end if;
    select * into rev from payroll_payment_event where company_id = new.company_id and id = new.reverses_event_id;
    if rev.bank_line_id is distinct from new.bank_line_id or rev.event_kind is distinct from 'CONFIRMED' or rev.currency_code is distinct from new.currency_code then
      raise exception 'a reversal points at the confirmed event of the same line and currency' using errcode = '23514';
    end if;
    if new.amount > l.confirmed_amount - l.reversed_amount then
      raise exception 'a reversal cannot exceed the unreversed confirmed amount' using errcode = '23514';
    end if;
    next_reversed := l.reversed_amount + new.amount;
    next_state := case when next_reversed = l.confirmed_amount then 'REVERSED' else 'CONFIRMED' end;
  else
    if new.amount <> l.payable_amount then
      raise exception 'a payment event covers the whole allocation' using errcode = '23514';
    end if;
    if not ((new.event_kind = 'RESERVED' and l.payment_state = 'READY')
         or (new.event_kind = 'SUBMITTED' and l.payment_state = 'RESERVED')
         or (new.event_kind = 'UNKNOWN' and l.payment_state in ('RESERVED', 'SUBMITTED'))
         or (new.event_kind in ('CONFIRMED', 'FAILED', 'CANCELLED') and l.payment_state in ('RESERVED', 'SUBMITTED', 'UNKNOWN'))) then
      raise exception 'invalid payment transition % -> %', l.payment_state, new.event_kind using errcode = '23514';
    end if;
    next_state := new.event_kind;
    if new.event_kind = 'CONFIRMED' then
      next_confirmed := l.payable_amount;
    end if;
  end if;
  update payroll_bank_line
     set payment_state = next_state, confirmed_amount = next_confirmed, reversed_amount = next_reversed, last_event_sequence = new.sequence,
         updated_by = new.recorded_by
   where company_id = new.company_id and id = new.bank_line_id;
  return new;
end $$;
create trigger payroll_payment_event_apply before insert on payroll_payment_event for each row execute function hrms_payroll_payment_event_apply();
create trigger payroll_payment_event_append_only before update or delete on payroll_payment_event for each row execute function hrms_append_only();

-- ---------------------------------------------------------------------------------------------------------------
-- CI27 / BR-050 / H5: pending reservations plus net confirmed payments plus live holds never exceed the record's
-- payable amount. The core's capacity check (0043 hook) is extended with the ledger, and the same check runs when a
-- line's ledger state changes.
-- ---------------------------------------------------------------------------------------------------------------
create function hrms_payroll_payment_committed(p_company uuid, p_record uuid) returns numeric language sql stable as $$
  select coalesce(sum(case when payment_state in ('RESERVED', 'SUBMITTED', 'UNKNOWN') then payable_amount
                           when payment_state in ('CONFIRMED', 'REVERSED') then confirmed_amount - reversed_amount
                           else 0 end), 0)
    from payroll_bank_line where company_id = p_company and payroll_record_id = p_record
$$;

create or replace function hrms_payroll_hold_capacity() returns trigger language plpgsql as $$
declare
  payable numeric;
  held numeric;
  committed numeric;
begin
  select net into payable from payroll_record where company_id = new.company_id and id = new.payroll_record_id;
  select coalesce(sum(hold_amount), 0) into held from payroll_hold
   where company_id = new.company_id and payroll_record_id = new.payroll_record_id and state in ('PROPOSED', 'APPROVED_ACTIVE', 'EXPIRED_REVIEW');
  committed := hrms_payroll_payment_committed(new.company_id, new.payroll_record_id);
  if payable is null or held + committed > payable then
    -- The core's wording is kept (its tests match it); reserved and paid amounts now count too.
    raise exception 'held amounts exceed the payable amount of the payroll record (counting reserved and paid amounts)' using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger payroll_bank_line_within_payable after insert or update on payroll_bank_line deferrable initially deferred
  for each row execute function hrms_payroll_hold_capacity();

-- ---------------------------------------------------------------------------------------------------------------
-- DB117 issued outputs
-- ---------------------------------------------------------------------------------------------------------------
create table employee_issued_output (
  id                     uuid primary key default gen_random_uuid(),
  company_id             uuid not null references company (id) on delete restrict,
  employee_id            uuid not null,
  kind                   text not null check (kind in ('PAYSLIP', 'FORM16')),
  period_id              uuid not null,
  period_code            text not null check (btrim(period_code) <> '' and length(period_code) <= 40),
  output_version         integer not null check (output_version > 0),
  payroll_record_id      uuid,
  run_id                 uuid,
  publication_state      text not null default 'DRAFT' check (publication_state in ('DRAFT', 'ISSUED', 'SUPERSEDED')),
  -- DB117 "document": the confidential, system-generated stored file (not a general employee document, CI30).
  attachment_id          uuid not null,
  content_hash           text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  file_name              text not null check (btrim(file_name) <> '' and length(file_name) <= 255),
  issued_at              timestamptz,
  issued_by              uuid references user_account (id) on delete restrict,
  issued_assignment_id   uuid,
  supersedes_output_id   uuid,
  supersession_reason    text check (supersession_reason is null or (btrim(supersession_reason) <> '' and length(supersession_reason) <= 1000)),
  superseded_at          timestamptz,
  created_at             timestamptz not null default now(),
  created_by             uuid references user_account (id) on delete restrict,
  updated_at             timestamptz not null default now(),
  updated_by             uuid references user_account (id) on delete restrict,
  version                integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, id, employee_id),
  unique (company_id, employee_id, kind, period_id, output_version),
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict,
  foreign key (company_id, period_id) references payroll_period (company_id, id) on delete restrict,
  foreign key (company_id, payroll_record_id, employee_id) references payroll_record (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, payroll_record_id, run_id) references payroll_record (company_id, id, run_id) on delete restrict,
  foreign key (company_id, attachment_id, employee_id) references attachment (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, supersedes_output_id, employee_id) references employee_issued_output (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, issued_assignment_id) references role_assignment (company_id, id) on delete restrict,
  check (kind <> 'PAYSLIP' or (payroll_record_id is not null and run_id is not null)),
  check ((publication_state in ('ISSUED', 'SUPERSEDED')) = (issued_at is not null)),
  check ((issued_at is null) = (issued_by is null)),
  check ((publication_state = 'SUPERSEDED') = (superseded_at is not null)),
  check ((output_version = 1) = (supersedes_output_id is null)),
  check ((supersedes_output_id is null) = (supersession_reason is null))
);
create unique index employee_issued_output_one_issued on employee_issued_output (company_id, employee_id, kind, period_id) where (publication_state = 'ISSUED');
create unique index employee_issued_output_one_successor on employee_issued_output (company_id, supersedes_output_id) where (supersedes_output_id is not null);

create function hrms_employee_issued_output_guard() returns trigger language plpgsql as $$
declare
  run_state text;
begin
  if tg_op = 'INSERT' then
    if new.kind = 'FORM16' then
      -- FR-107 / TN07 / H8: a tax certificate needs the actual applicable statutory template; none is configured.
      raise exception 'a tax certificate cannot be issued without the applicable statutory template' using errcode = '23514';
    end if;
    select ru.state into run_state from payroll_run ru where ru.company_id = new.company_id and ru.id = new.run_id;
    if run_state is distinct from 'PROCESSED_LOCKED' then
      raise exception 'a payslip is issued from a processed payroll record only' using errcode = '23514';
    end if;
    if new.publication_state <> 'ISSUED' then
      raise exception 'an output is stored when it is issued' using errcode = '23514';
    end if;
    return new;
  end if;
  if (new.employee_id, new.kind, new.period_id, new.period_code, new.output_version, new.payroll_record_id, new.run_id, new.attachment_id,
      new.content_hash, new.file_name, new.issued_at, new.issued_by, new.issued_assignment_id, new.supersedes_output_id, new.supersession_reason)
     is distinct from (old.employee_id, old.kind, old.period_id, old.period_code, old.output_version, old.payroll_record_id, old.run_id, old.attachment_id,
      old.content_hash, old.file_name, old.issued_at, old.issued_by, old.issued_assignment_id, old.supersedes_output_id, old.supersession_reason) then
    raise exception 'an issued output never changes; a replacement is a new version' using errcode = '23514';
  end if;
  if new.publication_state is distinct from old.publication_state and not (old.publication_state = 'ISSUED' and new.publication_state = 'SUPERSEDED') then
    raise exception 'invalid issued output transition % -> %', old.publication_state, new.publication_state using errcode = '23514';
  end if;
  return new;
end $$;
create trigger employee_issued_output_guard before insert or update on employee_issued_output for each row execute function hrms_employee_issued_output_guard();

do $$
declare
  t text;
begin
  foreach t in array array['payroll_bank_template', 'payroll_bank_batch', 'payroll_bank_line', 'employee_issued_output'] loop
    execute format('create trigger %I before update on %I for each row execute function hrms_touch()', t || '_touch', t);
    execute format('create trigger %I before delete on %I for each row execute function hrms_no_delete()', t || '_no_delete', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Permission catalogue. Template configuration is operational; manifests, lines, outcomes, payslip previews and
-- registers carry amounts (confidential, eligible Admin only, DF02); the restricted bank file carries bank values.
-- The Employee OWN context reads its own issued payslips (own-ESS, H1/BR-053).
-- ---------------------------------------------------------------------------------------------------------------
insert into permission (resource, action, field_group, own_ess) values
  ('payroll_bank_template', 'read',           'operational', false),
  ('payroll_bank_template', 'manage',         'operational', false),
  ('payroll_bank_template', 'validate',       'operational', false),
  ('payroll_bank_template', 'activate',       'operational', false),
  ('payroll_bank',          'read',           'amount',      false),
  ('payroll_bank',          'prepare',        'amount',      false),
  ('payroll_bank',          'authorize',      'amount',      false),
  ('payroll_bank',          'download',       'bank',        false),
  ('payroll_bank',          'record_outcome', 'amount',      false),
  ('payroll_output',        'read',           'amount',      false),
  ('payroll_output',        'publish',        'amount',      false),
  ('payroll_report',        'read',           'amount',      false),
  ('payroll_statutory',     'read',           'operational', false),
  ('payslip',               'read',           'payslip',     true);
