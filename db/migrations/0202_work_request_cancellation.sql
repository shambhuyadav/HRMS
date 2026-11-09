-- 0202 Cancelling an approved outdoor-duty or holiday-work request (I-84 item 15; decided under owner delegation, 6 Nov 2026; I-74
-- item 10; FR-027; DF03 "approved changes need a controlled reversal/cancellation action"; DF04; I-81 item 3).
--
-- APPROVED was a non-terminal state with no way out (db/tests/state-catalogue.test.ts named it a dead end). It now leads to CANCELLED,
-- which is terminal: by the employee before the request's first day, or by HR (work_request.cancel, row scope, never one's own
-- record) before its first day or when every day of it is after the approved last working date (work-request/service.ts). A
-- cancelled request no longer holds its days: the overlap rule below and the leave and attendance reads count SUBMITTED, RETURNED
-- and APPROVED only. The request, its approval and its history are kept.
--   work_request.cancel   a default duty of new HR Administrator assignments (operational: kind, dates and state, never the purpose
--                         beyond what HR already reads). Existing approved assignments keep their frozen allowlists (0099).
do $$
declare
  k text;
begin
  foreach k in array array['outdoor_duty', 'holiday_work'] loop
    execute format('alter table %I drop constraint %I', k || '_request', k || '_request_state_check');
    execute format($c$alter table %I add constraint %I check (state in ('SUBMITTED', 'RETURNED', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'CANCELLED'))$c$, k || '_request', k || '_request_state_check');
    insert into transaction_state (kind, state, initial, terminal) values (k, 'CANCELLED', false, true);
    insert into transaction_transition (kind, from_state, to_state) values (k, 'APPROVED', 'CANCELLED');
  end loop;
end $$;

insert into permission (resource, action, field_group) values ('work_request', 'cancel', 'operational') on conflict do nothing;

insert into role_permission (company_id, role_id, permission_id, effect)
select r.company_id, r.id, p.id, 'ALLOW'
  from role r
  join permission p on p.resource = 'work_request' and p.action = 'cancel' and p.field_group = 'operational'
 where r.code = 'HR_ADMINISTRATOR'
on conflict (company_id, role_id, permission_id) do nothing;
