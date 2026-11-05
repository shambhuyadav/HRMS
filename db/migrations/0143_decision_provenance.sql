-- 0143 Where a recorded decision came from, and whose records it touches (CI11; CI17; CI18; CI20; DB092 "event subject matches
-- transaction owner where applicable" line 4021; BRD line 4560). These guards look at new rows only: no stored row is read or
-- changed, so a database with existing rows always upgrades. Needs hrms_columns_fixed (0141).

-- 1. A confirmation action or an increment's history row names a decision of its own case's approval, as expense lines already do
--    (0012). Without this, any decision of the company could stand behind any outcome.
create function hrms_decision_of_transaction(p_company uuid, p_decision uuid, p_transaction uuid) returns boolean language sql stable as $$
  select exists (
    select 1
      from approval_decision d
      join approval_task t on t.company_id = d.company_id and t.id = d.task_id
      join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id
     where d.company_id = p_company and d.id = p_decision and i.transaction_id = p_transaction)
$$;

create function hrms_confirmation_action_provenance() returns trigger language plpgsql as $$
begin
  if not hrms_decision_of_transaction(new.company_id, new.approval_decision_id,
       (select transaction_id from employee_confirmation where company_id = new.company_id and id = new.confirmation_id)) then
    raise exception 'a confirmation action names a decision of its own case' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger confirmation_action_provenance before insert on confirmation_action for each row execute function hrms_confirmation_action_provenance();

-- 2. An increment's history keeps its case's basis and currency, and the arrangement it created has that currency too.
create function hrms_increment_history_provenance() returns trigger language plpgsql as $$
declare
  c increment_case%rowtype;
  new_currency text;
begin
  select * into c from increment_case where company_id = new.company_id and id = new.case_id;
  if not hrms_decision_of_transaction(new.company_id, new.approval_decision_id, c.transaction_id) then
    raise exception 'an increment history row names a decision of its own case' using errcode = '23514';
  end if;
  select currency_code into new_currency from salary_arrangement where company_id = new.company_id and id = new.new_salary_id;
  if (new.compensation_basis, new.currency_code) is distinct from (c.compensation_basis, c.currency_code) or new.currency_code is distinct from new_currency then
    raise exception 'an increment history row keeps the basis and currency of its case and new arrangement' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger increment_history_provenance before insert on increment_history for each row execute function hrms_increment_history_provenance();

-- 3. What a confirmation case was opened from stays as it was; only the due date it currently has moves.
create trigger employee_confirmation_fixed before update on employee_confirmation for each row
  execute function hrms_columns_fixed('policy_id', 'start_date', 'initial_due_date');

-- 4. A receipt is a file of the claimant (DF06 "cannot retrieve another person's receipt"): another employee's file, or one
--    belonging to no one, cannot be attached to a claim.
create function hrms_expense_receipt_owner() returns trigger language plpgsql as $$
declare
  claimant uuid;
  file_employee uuid;
begin
  select c.employee_id into claimant
    from expense_line l
    join expense_revision r on r.company_id = l.company_id and r.id = l.revision_id
    join expense_claim c on c.company_id = r.company_id and c.id = r.claim_id
   where l.company_id = new.company_id and l.id = new.line_id;
  select employee_id into file_employee from attachment where company_id = new.company_id and id = new.attachment_id;
  if file_employee is distinct from claimant then
    raise exception 'a receipt is a file of the claimant' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger expense_receipt_owner before insert on expense_receipt for each row execute function hrms_expense_receipt_owner();

-- 5. DB092: an event about a transaction has that transaction's owner as its subject, when both are stated.
create function hrms_notification_event_subject() returns trigger language plpgsql as $$
declare
  owner_id uuid;
begin
  if new.subject_employee_id is null or new.transaction_id is null then
    return new;
  end if;
  select owner_employee_id into owner_id from business_transaction where company_id = new.company_id and id = new.transaction_id;
  if owner_id is not null and owner_id <> new.subject_employee_id then
    raise exception 'a notification event about a transaction has its owner as subject' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger notification_event_subject before insert on notification_event for each row execute function hrms_notification_event_subject();
