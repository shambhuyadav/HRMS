-- 0048 Supporting evidence of a request revision (FR-027 "supporting evidence"; FR-106; CI08). The requester's own
-- documents are linked to one revision of a business transaction; a resubmission links its own set, and earlier
-- revisions keep theirs. Links are append-only. Who may open the file is decided by the API (the owner and the
-- reviewers assigned to that transaction, released files only).
create table transaction_evidence (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references company (id) on delete restrict,
  transaction_id        uuid not null,
  transaction_revision  integer not null check (transaction_revision > 0),
  employee_id           uuid not null,
  document_id           uuid not null,
  created_at            timestamptz not null default now(),
  created_by            uuid references user_account (id) on delete restrict,
  unique (company_id, transaction_id, transaction_revision, document_id),
  foreign key (company_id, transaction_id) references business_transaction (company_id, id) on delete restrict,
  -- CI08: the evidence is a document of the same employee.
  foreign key (company_id, document_id, employee_id) references employee_document (company_id, id, employee_id) on delete restrict
);
create index transaction_evidence_transaction_idx on transaction_evidence (company_id, transaction_id, transaction_revision);

-- The evidence belongs to the transaction's owner, and only to its current revision when linked.
create function hrms_transaction_evidence_guard() returns trigger language plpgsql as $$
declare
  bt business_transaction%rowtype;
begin
  select * into bt from business_transaction where company_id = new.company_id and id = new.transaction_id;
  if bt.owner_employee_id is distinct from new.employee_id then
    raise exception 'evidence must be a document of the request owner' using errcode = '23514';
  end if;
  if bt.revision <> new.transaction_revision then
    raise exception 'evidence is linked to the current revision only' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger transaction_evidence_guard before insert on transaction_evidence for each row execute function hrms_transaction_evidence_guard();
create trigger transaction_evidence_append_only before update or delete on transaction_evidence for each row execute function hrms_append_only();
