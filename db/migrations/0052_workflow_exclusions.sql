-- C4: the users a transaction's approval must never go to (its preparer, its requester, those who cannot open it),
-- named when the approval starts, are kept with the approval instance so that every later step honours them, not only
-- the first (workflow/engine.ts startApproval excludeUserIds; decision I-25).
alter table approval_instance add column excluded_user_ids uuid[] not null default '{}';
