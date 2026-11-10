-- 0256 Payroll and expense independence includes the delegator (docs/03 I-57 item 7: "payroll and expense independence checks
-- compare the actual actor, not the delegator: extend?"; C4 "Preserve delegator, delegate and actual actor"; RBAC instruction
-- line 95). Decided under owner delegation (6 Nov 2026): a decision a delegate takes under a delegation is taken in the delegator's
-- name, so for every later segregation-of-duties check it counts as the delegator's as well as the delegate's, as the workflow
-- engine already treats it for later steps of the same approval (priorDecidersOf). Nobody gains a right from this; it only refuses
-- more. The services check the same (payroll/common.ts decisionDelegators, taskDelegator).
--
-- 1. Expense payments (0088; DF02, DF03, C4): the delegator of a decision on the claim's approval counts as its decider, so they
--    neither prepare its payment (the entitlement's final approval or a line decision taken in their name) nor release it or
--    record its outcome (any decision on the claim taken in their name). Same signatures; the triggers and checks that call these
--    functions follow at once.
-- 2. Payroll holds (0043 hrms_payroll_hold_guard, C4 / H4): the delegator of a delegated review, approval or covering approval of
--    the run never decides or releases a hold of its records.

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Expense payment conflicts
-- ---------------------------------------------------------------------------------------------------------------
create or replace function hrms_payment_preparer_conflict(p_company uuid, p_obligation uuid, p_actor uuid) returns boolean language sql stable as $$
  select exists (select 1 from expense_obligation o where o.company_id = p_company and o.id = p_obligation and o.approved_by = p_actor)
      or exists (select 1 from expense_obligation o
                   join expense_line l on l.company_id = o.company_id and l.revision_id = o.revision_id
                   join expense_line_decision ld on ld.company_id = l.company_id and ld.line_id = l.id
                   join approval_decision d on d.company_id = ld.company_id and d.id = ld.approval_decision_id
                   join approval_task t on t.company_id = d.company_id and t.id = d.task_id
                   left join delegation dl on dl.company_id = t.company_id and dl.id = t.delegation_id
                  where o.company_id = p_company and o.id = p_obligation and (d.actor_user_id = p_actor or dl.delegator_user_id = p_actor))
      -- The final approval (o.approved_by) taken by a delegate in p_actor's name.
      or exists (select 1 from expense_obligation o
                   join expense_revision r on r.company_id = o.company_id and r.id = o.revision_id
                   join expense_claim c on c.company_id = o.company_id and c.id = o.claim_id
                   join approval_instance ai on ai.company_id = c.company_id and ai.transaction_id = c.transaction_id and ai.transaction_revision = r.revision
                   join approval_task t on t.company_id = ai.company_id and t.instance_id = ai.id
                   join approval_decision d on d.company_id = t.company_id and d.task_id = t.id and d.actor_user_id = o.approved_by
                   join delegation dl on dl.company_id = t.company_id and dl.id = t.delegation_id
                  where o.company_id = p_company and o.id = p_obligation and dl.delegator_user_id = p_actor)
      or exists (select 1 from expense_obligation o
                   join user_employee_link u on u.company_id = o.company_id and u.employee_id = o.employee_id
                  where o.company_id = p_company and o.id = p_obligation and u.user_id = p_actor)
$$;

create or replace function hrms_payment_release_conflict(p_company uuid, p_instruction uuid, p_actor uuid) returns boolean language sql stable as $$
  select exists (select 1 from payment_instruction i join payment_batch b on b.company_id = i.company_id and b.id = i.batch_id
                  where i.company_id = p_company and i.id = p_instruction and b.prepared_by = p_actor)
      or exists (select 1 from payment_instruction i join user_employee_link u on u.company_id = i.company_id and u.employee_id = i.employee_id
                  where i.company_id = p_company and i.id = p_instruction and u.user_id = p_actor)
      or exists (select 1 from payment_allocation a join expense_obligation o on o.company_id = a.company_id and o.id = a.obligation_id
                  where a.company_id = p_company and a.instruction_id = p_instruction and o.approved_by = p_actor)
      or exists (select 1 from payment_allocation a
                   join expense_obligation o on o.company_id = a.company_id and o.id = a.obligation_id
                   join expense_revision r on r.company_id = o.company_id and r.id = o.revision_id
                   join expense_claim c on c.company_id = o.company_id and c.id = o.claim_id
                   join approval_instance ai on ai.company_id = c.company_id and ai.transaction_id = c.transaction_id and ai.transaction_revision = r.revision
                   join approval_task t on t.company_id = ai.company_id and t.instance_id = ai.id
                   join approval_decision d on d.company_id = t.company_id and d.task_id = t.id
                   left join delegation dl on dl.company_id = t.company_id and dl.id = t.delegation_id
                  where a.company_id = p_company and a.instruction_id = p_instruction and (d.actor_user_id = p_actor or dl.delegator_user_id = p_actor))
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Payroll holds: independent of the run's delegators too
-- ---------------------------------------------------------------------------------------------------------------
create function hrms_payroll_hold_delegated_run_decider() returns trigger language plpgsql as $$
declare
  actor uuid;
begin
  if new.approved_by is not null and old.approved_by is null then
    actor := new.approved_by;
  elsif new.released_by is not null and old.released_by is null then
    actor := new.released_by;
  else
    return new;
  end if;
  if exists (
    select 1
      from approval_instance i
      join approval_task t on t.company_id = i.company_id and t.instance_id = i.id
      join approval_decision d on d.company_id = t.company_id and d.task_id = t.id
      join delegation dl on dl.company_id = t.company_id and dl.id = t.delegation_id
     where i.company_id = new.company_id and dl.delegator_user_id = actor
       and i.transaction_id in (select transaction_id from payroll_run where company_id = new.company_id and id = new.run_id
                                union all select transaction_id from payroll_run_approval where company_id = new.company_id and run_id = new.run_id
                                union all select transaction_id from payroll_record_cover where company_id = new.company_id and run_id = new.run_id)) then
    raise exception 'a hold is decided and released independently of the payroll run it holds, delegated decisions included' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger payroll_hold_delegated_run_decider before update on payroll_hold for each row execute function hrms_payroll_hold_delegated_run_decider();
