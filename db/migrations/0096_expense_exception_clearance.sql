-- 0096 Expense exception clearance (FR-073; FR-075; BR-021; BR-023; DF02; DF06).
-- 1. Accepting a flagged line (duplicate suspected, over limit, late, receipt missing) is a documented review: its line
--    decision needs the reviewer's own reason at any allowed amount ("clearance retains its reason"; DF06 "records a
--    reason for reduction/rejection/exception"). The check runs on new line decisions only: decisions already recorded
--    stay as they are, and a claim still in review gets its reason when it is decided.
-- 2. The claimant's justification of a flagged line and the reviewer's clearance reason are private reasons (DF02), so
--    they get their own `reason` field group. No confidential_field_policy row marks it operational, so it is
--    CONFIDENTIAL and reaches a caller only through an approved Admin/Manager assignment that grants it (C1). It is a
--    ceiling-only grant of the HR Administrator role (modules/access/baseline.ts), never a default duty, and not an
--    own-ESS permission: H1 lists no expense reason.
create or replace function hrms_expense_line_decision_check() returns trigger language plpgsql as $$
declare
  ok boolean;
  claimed numeric;
  flags text[];
begin
  select l.claimed_amount, l.exception_flags,
         exists (select 1 from approval_decision d
                   join approval_task t on t.company_id = d.company_id and t.id = d.task_id
                   join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id
                   join expense_claim c on c.company_id = i.company_id and c.transaction_id = i.transaction_id
                  where d.company_id = new.company_id and d.id = new.approval_decision_id
                    and c.id = r.claim_id and i.transaction_revision = r.revision)
    into claimed, flags, ok
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
  if cardinality(flags) > 0 and (new.exception_reason is null or btrim(new.exception_reason) = '') then
    raise exception 'a flagged line needs a recorded clearance reason' using errcode = '23514';
  end if;
  return new;
end $$;

insert into permission (resource, action, field_group) values ('expense', 'read', 'reason');
