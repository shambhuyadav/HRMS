-- 0185 Exit entry, settlement payment and void, in-app delivery (FR-018, FR-051, FR-053, FR-054, FR-055; BR-016; DF07; DF08;
-- DF09; H7). Decided under owner delegation, 6 Nov 2026 (docs/03 I-81); every rule below can be reversed by a later migration.
--
-- 1. FR-051 (I-40 item 4): HR may enter a resignation the employee gave outside the system (a letter or e-mail). It carries
--    its origin, who entered it and one released, verified document of the employee as evidence, all fixed once recorded;
--    whoever entered it never decides it (the service excludes them from the route).
-- 2. FR-053, FR-054 (I-40 item 2): a settlement is paid outside the system (DF07: no bank transfer is sent) and its payment is
--    recorded from evidence: RELEASE_ELIGIBLE -> PAID with the payment date, reference, an idempotent evidence key and one
--    verified document, by someone other than the preparer and the release marker. The payment date is the disbursement month.
-- 3. FR-051, FR-053 (I-48 item 15) and FR-052 (I-48 item 14): a settlement not yet paid can be voided (CANCELLED with its
--    reason, everything kept), by an approved withdrawal or by an independent approver; its open approval stage ends with it.
-- 4. FR-018, FR-054, DF09 (I-40 item 3): "send" is in-app delivery to the person's own self-service. A delivery names the
--    file delivered (the letter's own stored output, or a statement rendered once at sending), the recipient reviewed by the
--    sender, the sender and the time; the only later change is the first time the employee opens it. No e-mail, no attachment.

-- 1. Resignations entered by HR ------------------------------------------------------------------------------------------------
alter table exit_case
  add column request_origin text not null default 'EMPLOYEE' check (request_origin in ('EMPLOYEE', 'HR')),
  add column entered_by uuid references user_account (id) on delete restrict,
  add column evidence_document_id uuid,
  add column evidence_reference text check (evidence_reference is null or (btrim(evidence_reference) <> '' and length(evidence_reference) <= 500));
alter table exit_case add constraint exit_case_evidence_document_fk
  foreign key (company_id, evidence_document_id) references employee_document (company_id, id) on delete restrict;
alter table exit_case add constraint exit_case_origin_facts check (
  (request_origin = 'HR') = (entered_by is not null)
  and (request_origin = 'HR') = (evidence_document_id is not null)
  and (request_origin = 'HR') = (evidence_reference is not null));

create function hrms_exit_case_origin_guard() returns trigger language plpgsql as $$
begin
  if (new.request_origin, new.entered_by, new.evidence_document_id, new.evidence_reference)
     is distinct from (old.request_origin, old.entered_by, old.evidence_document_id, old.evidence_reference) then
    raise exception 'the origin and evidence of a resignation are fixed once recorded' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger exit_case_origin_guard before update on exit_case for each row execute function hrms_exit_case_origin_guard();

-- 2 and 3. Settlement payment and void -------------------------------------------------------------------------------------------
alter table settlement
  add column cancel_reason text check (cancel_reason is null or (btrim(cancel_reason) <> '' and length(cancel_reason) <= 1000)),
  add column paid_at timestamptz,
  add column paid_by uuid references user_account (id) on delete restrict,
  add column paid_assignment_id uuid,
  add column payment_date date,
  add column payment_reference text check (payment_reference is null or (btrim(payment_reference) <> '' and length(payment_reference) <= 500)),
  add column payment_evidence_key text check (payment_evidence_key is null or payment_evidence_key ~ '^[A-Za-z0-9._:-]{8,100}$'),
  add column payment_document_id uuid;
alter table settlement add constraint settlement_paid_assignment_fk foreign key (company_id, paid_assignment_id) references role_assignment (company_id, id) on delete restrict;
alter table settlement add constraint settlement_payment_document_fk foreign key (company_id, payment_document_id) references employee_document (company_id, id) on delete restrict;
alter table settlement add constraint settlement_payment_evidence_key unique (company_id, payment_evidence_key);

-- The state list gains PAID; RELEASE_ELIGIBLE is no longer the end, and a voided revision keeps its release marker.
do $$
declare
  c record;
  dropped integer := 0;
begin
  for c in select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'settlement'::regclass and contype = 'c' loop
    if c.conname = 'settlement_state_check'
       or c.def like '%(state = ''RELEASE_ELIGIBLE''::text) = (release_eligible_at IS NOT NULL)%' then
      execute format('alter table settlement drop constraint %I', c.conname);
      dropped := dropped + 1;
    end if;
  end loop;
  if dropped <> 2 then
    raise exception 'expected the settlement state and release checks, found %', dropped;
  end if;
end $$;
alter table settlement add constraint settlement_state_check check (state in ('DRAFT', 'SUBMITTED', 'REVIEWED', 'APPROVED', 'RELEASE_ELIGIBLE', 'PAID', 'RETURNED', 'REJECTED', 'CANCELLED'));
alter table settlement add constraint settlement_release_marker check (
  (state not in ('RELEASE_ELIGIBLE', 'PAID') or release_eligible_at is not null)
  and (release_eligible_at is null or state in ('RELEASE_ELIGIBLE', 'PAID', 'CANCELLED')));
alter table settlement add constraint settlement_payment_facts check (
  (state = 'PAID') = (paid_at is not null)
  and (paid_at is null) = (paid_by is null) and (paid_at is null) = (paid_assignment_id is null) and (paid_at is null) = (payment_date is null)
  and (paid_at is null) = (payment_reference is null) and (paid_at is null) = (payment_evidence_key is null) and (paid_at is null) = (payment_document_id is null));
alter table settlement add constraint settlement_paid_after_approval check (state <> 'PAID' or (reviewed_at is not null and approved_at is not null));
-- C4: the person recording the payment neither prepared the revision nor marked it eligible for release.
alter table settlement add constraint settlement_payment_independent check (paid_by is null or (paid_by <> prepared_by and paid_by <> release_eligible_by));
alter table settlement add constraint settlement_cancel_reason check (cancel_reason is null or state = 'CANCELLED');

create function hrms_settlement_outcome_guard() returns trigger language plpgsql as $$
begin
  if old.paid_at is not null and (new.paid_at, new.paid_by, new.paid_assignment_id, new.payment_date, new.payment_reference, new.payment_evidence_key, new.payment_document_id)
     is distinct from (old.paid_at, old.paid_by, old.paid_assignment_id, old.payment_date, old.payment_reference, old.payment_evidence_key, old.payment_document_id) then
    raise exception 'a recorded settlement payment never changes' using errcode = '23514';
  end if;
  if old.cancel_reason is not null and new.cancel_reason is distinct from old.cancel_reason then
    raise exception 'the reason a settlement was cancelled is fixed' using errcode = '23514';
  end if;
  if old.release_eligible_at is not null and (new.release_eligible_at, new.release_eligible_by, new.release_eligible_assignment_id)
     is distinct from (old.release_eligible_at, old.release_eligible_by, old.release_eligible_assignment_id) then
    raise exception 'a release marker is recorded once' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger settlement_outcome_guard before update on settlement for each row execute function hrms_settlement_outcome_guard();

do $$
declare
  c record;
  dropped integer := 0;
begin
  for c in select conname from pg_constraint where conrelid = 'settlement_approval'::regclass and contype = 'c' and conname = 'settlement_approval_state_check' loop
    execute format('alter table settlement_approval drop constraint %I', c.conname);
    dropped := dropped + 1;
  end loop;
  if dropped <> 1 then
    raise exception 'expected the settlement approval state check, found %', dropped;
  end if;
end $$;
alter table settlement_approval add constraint settlement_approval_state_check check (state in ('SUBMITTED', 'APPROVED', 'REJECTED', 'RETURNED', 'CANCELLED'));

update transaction_state set terminal = false where kind = 'settlement' and state = 'RELEASE_ELIGIBLE';
insert into transaction_state (kind, state, initial, terminal) values
  ('settlement', 'PAID', false, true),
  ('settlement_approval', 'CANCELLED', false, true);
insert into transaction_transition (kind, from_state, to_state) values
  ('settlement', 'RELEASE_ELIGIBLE', 'PAID'),
  ('settlement', 'SUBMITTED', 'CANCELLED'),
  ('settlement', 'REVIEWED', 'CANCELLED'),
  ('settlement', 'APPROVED', 'CANCELLED'),
  ('settlement', 'RELEASE_ELIGIBLE', 'CANCELLED'),
  ('settlement_approval', 'SUBMITTED', 'CANCELLED');

-- 4. In-app delivery -------------------------------------------------------------------------------------------------------------
alter table letter_output add constraint letter_output_company_id_id_employee_id_key unique (company_id, id, employee_id);

create table ess_delivery (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references company (id) on delete restrict,
  employee_id          uuid not null,
  source_kind          text not null check (source_kind in ('LETTER', 'SETTLEMENT_STATEMENT')),
  letter_output_id     uuid,
  settlement_id        uuid,
  -- What the employee opens: the letter's stored output, or the statement rendered once when it was sent.
  attachment_id        uuid not null,
  file_format          text not null check (file_format in ('TEXT', 'PDF', 'XLSX')),
  -- The template revision of a letter, or the settlement revision of a statement.
  source_revision      integer not null check (source_revision > 0),
  -- FR-018 "recipient review": the employee the sender confirmed, and the account it was delivered to.
  recipient_user_id    uuid not null references user_account (id) on delete restrict,
  sent_by              uuid not null references user_account (id) on delete restrict,
  sent_assignment_id   uuid not null,
  sent_at              timestamptz not null default now(),
  first_read_at        timestamptz,
  idempotency_key      text check (idempotency_key is null or idempotency_key ~ '^[A-Za-z0-9._:-]{8,100}$'),
  created_at           timestamptz not null default now(),
  created_by           uuid not null references user_account (id) on delete restrict,
  unique (company_id, id),
  unique (company_id, idempotency_key),
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict,
  foreign key (company_id, letter_output_id, employee_id) references letter_output (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, settlement_id, employee_id) references settlement (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, attachment_id, employee_id) references attachment (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, sent_assignment_id) references role_assignment (company_id, id) on delete restrict,
  check ((source_kind = 'LETTER') = (letter_output_id is not null)),
  check ((source_kind = 'SETTLEMENT_STATEMENT') = (settlement_id is not null)),
  check ((source_kind = 'LETTER') = (file_format = 'TEXT')),
  check (sent_by <> recipient_user_id),
  check (created_by = sent_by),
  check (first_read_at is null or first_read_at >= sent_at)
);
create index ess_delivery_employee_idx on ess_delivery (company_id, employee_id, sent_at desc);
create index ess_delivery_letter_idx on ess_delivery (company_id, letter_output_id) where (letter_output_id is not null);
create index ess_delivery_settlement_idx on ess_delivery (company_id, settlement_id) where (settlement_id is not null);

create function hrms_ess_delivery_guard() returns trigger language plpgsql as $$
begin
  if (new.company_id, new.employee_id, new.source_kind, new.letter_output_id, new.settlement_id, new.attachment_id, new.file_format, new.source_revision,
      new.recipient_user_id, new.sent_by, new.sent_assignment_id, new.sent_at, new.idempotency_key, new.created_at, new.created_by)
     is distinct from
     (old.company_id, old.employee_id, old.source_kind, old.letter_output_id, old.settlement_id, old.attachment_id, old.file_format, old.source_revision,
      old.recipient_user_id, old.sent_by, old.sent_assignment_id, old.sent_at, old.idempotency_key, old.created_at, old.created_by) then
    raise exception 'a delivery is fixed once sent' using errcode = '23514';
  end if;
  if old.first_read_at is not null and new.first_read_at is distinct from old.first_read_at then
    raise exception 'the first reading of a delivery is recorded once' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger ess_delivery_guard before update on ess_delivery for each row execute function hrms_ess_delivery_guard();
create trigger ess_delivery_no_delete before delete on ess_delivery for each row execute function hrms_no_delete();

-- Permission catalogue. Recording a settlement payment and sending a statement or a letter are rights of their own (FR-002),
-- ceiling-only grants of the HR Administrator (modules/lifecycle/registration.ts); the employee reads their own deliveries in the
-- Employee OWN context (H1/BR-053 own outputs). Existing companies receive the ceilings when they are next provisioned.
insert into permission (resource, action, field_group, own_ess) values
  ('settlement',   'record_payment', 'amount',   false),
  ('settlement',   'send',           'amount',   false),
  ('letter',       'send',           'letter',   false),
  ('own_delivery', 'read',           'delivery', true);
