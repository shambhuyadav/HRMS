-- 0082 Cancelling a confirmation review (FR-082 "confirming or cancelling the review suppresses future open-review
-- reminders"; DF11 "Confirmed/cancelled closes the active task"; BR-031 "Closed reviews do not generate open-review
-- reminders"; DF12 "no repeated due reminder after terminal state").
-- An authorised HR user cancels a review that is open or whose recommendation waits for the HR decision, and an approved
-- exit or a separation closes it the same way; the pending decision task closes with it (0009 had OPEN -> CANCELLED
-- only). The reason is private, like the recommendation and decision reasons (the confirmation `reason` group, 0020).
-- CANCELLED is terminal (0009); the case and its history are kept (DF08).

insert into transaction_transition (kind, from_state, to_state) values ('employee_confirmation', 'REVIEW_PENDING', 'CANCELLED');

alter table employee_confirmation
  add column cancelled_at  timestamptz,
  add column cancelled_by  uuid references user_account (id) on delete restrict,
  add column cancel_reason text check (cancel_reason is null or (btrim(cancel_reason) <> '' and length(cancel_reason) <= 1000)),
  add constraint employee_confirmation_cancellation_recorded check (
    (state = 'CANCELLED') = (cancelled_at is not null)
    and (cancelled_at is null) = (cancelled_by is null)
    and (cancelled_at is null) = (cancel_reason is null)
  );
