-- 0190 Offer letters while an offer is being made (FR-014, FR-017, FR-018; DF09; F1 hiring; C4). Decided under owner
-- delegation, 6 Nov 2026 (docs/03 I-82 item 1, answering I-48 item 2). Synthetic data only.
--
-- * Wording: a versioned letter template of the OFFER letter type (letter_template, 0038), published by HR. An OFFER
--   template may use only the offer placeholders (lifecycle/letters.ts OFFER_LETTER_PLACEHOLDERS): candidate, requisition,
--   company and letter date, and the terms and compensation of the approved offer revision. No amount is ever typed into
--   a letter: every figure comes from hiring_offer_revision, which an independent eligible Admin approved (F1, C4).
-- * Preparation: an eligible HR Administrator assignment holding offer.issue_letter.compensation (ceiling only, never a
--   default duty) previews and generates the letter, only while the offer is APPROVED or ACCEPTED and only from its current
--   approved revision. The output is the exact rendered text, stored as a confidential attachment with the template code and
--   revision, the offer revision, generator, assignment and time (FR-017); a regeneration is a new output.
-- * Delivery (DF09 "email attachments containing confidential records are disabled; in-app authorised access only"): the
--   system never sends the letter. The issuing Admin downloads it in-app and hands it to the candidate outside the system,
--   then records the delivery: method (a company list, OFFER_LETTER_DELIVERY), date, the confirmed recipient (the offer's
--   candidate, FR-018 "recipient review") and who recorded it. A recorded delivery is final.
create table hiring_offer_letter (
  id                        uuid primary key default gen_random_uuid(),
  company_id                uuid not null references company (id) on delete restrict,
  offer_id                  uuid not null,
  -- The approved revision whose terms and compensation the letter carries.
  offer_revision            integer not null check (offer_revision > 0),
  template_id               uuid not null,
  template_revision_id      uuid not null,
  template_code             text not null,
  template_revision         integer not null check (template_revision > 0),
  output_number             integer not null check (output_number > 0),
  attachment_id             uuid not null,
  checksum                  text not null check (checksum ~ '^[0-9a-f]{64}$'),
  generated_at              timestamptz not null default now(),
  generated_by              uuid not null references user_account (id) on delete restrict,
  generated_assignment_id   uuid not null,
  -- Optional client key: a retried generation returns the output it already stored instead of a second one.
  idempotency_key           text check (idempotency_key is null or idempotency_key ~ '^[A-Za-z0-9._:-]{8,100}$'),
  delivery_state            text not null default 'NOT_DELIVERED' check (delivery_state in ('NOT_DELIVERED', 'DELIVERED')),
  delivery_method_category  text not null default 'OFFER_LETTER_DELIVERY' check (delivery_method_category = 'OFFER_LETTER_DELIVERY'),
  delivery_method_id        uuid,
  delivered_on              date,
  delivery_recorded_by      uuid references user_account (id) on delete restrict,
  delivery_assignment_id    uuid,
  delivery_recorded_at      timestamptz,
  created_at                timestamptz not null default now(),
  created_by                uuid references user_account (id) on delete restrict,
  unique (company_id, id),
  unique (company_id, attachment_id),
  unique (company_id, offer_id, output_number),
  foreign key (company_id, offer_id) references hiring_offer (company_id, id) on delete restrict,
  foreign key (company_id, offer_id, offer_revision) references hiring_offer_revision (company_id, offer_id, revision) on delete restrict,
  foreign key (company_id, template_id, template_code) references letter_template (company_id, id, code) on delete restrict,
  foreign key (company_id, template_revision_id, template_id, template_revision)
    references letter_template_revision (company_id, id, template_id, revision) on delete restrict,
  foreign key (company_id, attachment_id) references attachment (company_id, id) on delete restrict,
  foreign key (company_id, generated_assignment_id) references role_assignment (company_id, id) on delete restrict,
  foreign key (company_id, delivery_method_category, delivery_method_id) references reference_value (company_id, category, id) on delete restrict,
  foreign key (company_id, delivery_assignment_id) references role_assignment (company_id, id) on delete restrict,
  -- FR-018: a delivery names its method, date, recorder and acting assignment; an undelivered output names none of them.
  check ((delivery_state = 'DELIVERED') = (delivery_method_id is not null and delivered_on is not null and delivery_recorded_by is not null
                                           and delivery_assignment_id is not null and delivery_recorded_at is not null)),
  check (delivery_state = 'DELIVERED' or (delivery_method_id is null and delivered_on is null and delivery_recorded_by is null
                                         and delivery_assignment_id is null and delivery_recorded_at is null))
);
create index hiring_offer_letter_offer_idx on hiring_offer_letter (company_id, offer_id, generated_at desc);
create unique index hiring_offer_letter_idempotency on hiring_offer_letter (company_id, idempotency_key) where (idempotency_key is not null);

-- The output is generated only from an OFFER template and from the current revision of an APPROVED or ACCEPTED offer; it is
-- fixed once stored, and its one change is the recorded delivery, made while that revision still stands.
create function hrms_hiring_offer_letter_guard() returns trigger language plpgsql as $$
declare
  offer_state text;
  offer_revision integer;
begin
  if tg_op = 'DELETE' then
    raise exception 'an offer letter output is kept' using errcode = '23514';
  end if;
  select o.state, o.current_revision into offer_state, offer_revision from hiring_offer o where o.company_id = new.company_id and o.id = new.offer_id;
  if tg_op = 'INSERT' then
    if new.delivery_state <> 'NOT_DELIVERED' then
      raise exception 'an offer letter output starts undelivered' using errcode = '23514';
    end if;
    if not exists (select 1 from letter_template t join reference_value ty on ty.company_id = t.company_id and ty.id = t.letter_type_id
                    where t.company_id = new.company_id and t.id = new.template_id and ty.code = 'OFFER') then
      raise exception 'an offer letter uses an OFFER letter template' using errcode = '23514';
    end if;
  else
    if (new.offer_id, new.offer_revision, new.template_id, new.template_revision_id, new.template_code, new.template_revision, new.output_number,
        new.attachment_id, new.checksum, new.generated_at, new.generated_by, new.generated_assignment_id, new.idempotency_key, new.created_at, new.created_by)
       is distinct from
       (old.offer_id, old.offer_revision, old.template_id, old.template_revision_id, old.template_code, old.template_revision, old.output_number,
        old.attachment_id, old.checksum, old.generated_at, old.generated_by, old.generated_assignment_id, old.idempotency_key, old.created_at, old.created_by) then
      raise exception 'an offer letter output is immutable' using errcode = '23514';
    end if;
    if old.delivery_state = 'DELIVERED' then
      raise exception 'a recorded offer letter delivery is final' using errcode = '23514';
    end if;
  end if;
  if offer_state is null or offer_state not in ('APPROVED', 'ACCEPTED') or offer_revision is distinct from new.offer_revision then
    raise exception 'an offer letter comes from the current revision of an approved or accepted offer' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger hiring_offer_letter_guard before insert or update or delete on hiring_offer_letter
  for each row execute function hrms_hiring_offer_letter_guard();
create trigger hiring_offer_letter_no_truncate before truncate on hiring_offer_letter for each statement execute function hrms_no_truncate();

-- Catalogue: issuing (preview, generation, recorded delivery) is its own confidential duty; reading the stored letters is
-- offer.read.compensation, the grant that reads the approved compensation the letter shows.
insert into permission (resource, action, field_group, own_ess) values
  ('offer', 'issue_letter', 'compensation', false);
