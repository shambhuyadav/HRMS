-- 0125 A new request links to the rejected predecessor (DF03 "Rejected requests are terminal; a new request links to the
-- rejected predecessor"; FR-026; FR-027; FR-059; FR-074; CI02).
--
-- Timesheets, sensitive changes, settlements and mobile links already carry their own link. The other requests are one
-- business_transaction per request (CI12), so the link is kept there once, on what every kind shares: an optional reference
-- to the transaction this one follows. The guard holds it for every kind, whatever path writes it:
--   * same company (the key), same kind and same owning employee: a request follows only its own kind, and only the owner's;
--   * the predecessor is REJECTED, a terminal state (a returned request is corrected and resubmitted, a withdrawn one was
--     never decided, an approved one has nothing to raise again);
--   * set when the request is created and never changed afterwards;
--   * at most one live successor. A successor that was itself rejected, withdrawn or cancelled no longer counts, so the
--     rejected request can be raised again.
alter table business_transaction add column predecessor_transaction_id uuid;
alter table business_transaction add constraint business_transaction_predecessor_fk
  foreign key (company_id, predecessor_transaction_id) references business_transaction (company_id, id) on delete restrict;

create unique index business_transaction_one_live_successor on business_transaction (company_id, predecessor_transaction_id)
  where predecessor_transaction_id is not null and state not in ('REJECTED', 'WITHDRAWN', 'CANCELLED');

create function hrms_transaction_predecessor_guard() returns trigger language plpgsql as $$
declare
  p record;
begin
  if tg_op = 'UPDATE' then
    if new.predecessor_transaction_id is distinct from old.predecessor_transaction_id then
      raise exception 'a request''s predecessor is immutable' using errcode = '23514';
    end if;
    return new;
  end if;
  if new.predecessor_transaction_id is null then
    return new;
  end if;
  select kind, owner_employee_id, state into p from business_transaction where company_id = new.company_id and id = new.predecessor_transaction_id;
  if not found then
    raise exception 'the predecessor is not a request of this company' using errcode = '23503';
  end if;
  if p.kind <> new.kind or new.owner_employee_id is null or p.owner_employee_id is distinct from new.owner_employee_id then
    raise exception 'a request follows only a request of the same kind and owner' using errcode = '23514';
  end if;
  if p.state <> 'REJECTED' then
    raise exception 'a request follows only a rejected request' using errcode = '23514';
  end if;
  return new;
end $$;

create trigger business_transaction_predecessor_guard
  before insert or update of predecessor_transaction_id on business_transaction
  for each row execute function hrms_transaction_predecessor_guard();
