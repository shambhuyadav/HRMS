-- 0152 A decided confirmation exception is final in full (ZT12 "Edit ... decision ... is denied"; C4; DF11). The guard froze the proposal
-- and refused any change of state, but a write that left the state as it was could still replace who decided it, when, why and under
-- which key, so a recorded decision could be reattributed by a direct write. The service never does this: it updates only a PROPOSED
-- row, under that row's lock. Found by removing the service's own state check and seeing a second approver accepted
-- (confirmation.concurrency.api.test.ts). This changes one function and reads no stored row, so it cannot stop an upgrade.
create or replace function hrms_confirmation_exception_guard() returns trigger language plpgsql as $$
begin
  if (new.confirmation_id, new.employee_id, new.kind, new.proposed_due_date, new.reason, new.proposed_by)
     is distinct from (old.confirmation_id, old.employee_id, old.kind, old.proposed_due_date, old.reason, old.proposed_by) then
    raise exception 'a confirmation exception proposal is immutable' using errcode = '23514';
  end if;
  if old.state <> 'PROPOSED'
     and (new.state, new.decided_by, new.decided_at, new.decision_reason, new.decision_key)
         is distinct from (old.state, old.decided_by, old.decided_at, old.decision_reason, old.decision_key) then
    raise exception 'confirmation exception in % is final', old.state using errcode = '23514';
  end if;
  return new;
end $$;
