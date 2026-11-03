-- 0051 Idempotent confirmation-exception decisions (ZT07; DF09 at-least-once): a decision may carry the client's
-- idempotency key, so a retried request returns the recorded decision instead of a conflict.
alter table confirmation_exception add column decision_key text check (decision_key is null or decision_key ~ '^[A-Za-z0-9._:-]{8,100}$');
create unique index confirmation_exception_decision_key on confirmation_exception (company_id, decision_key) where (decision_key is not null);
