-- 0032 Increment decision reasons are their own confidential group (DF02; same treatment as D-016 for confirmation
-- and attendance-amendment reasons). Salary history amounts stay in the salary group; the approver's free-text
-- reason needs a separately approved reason grant. Not an own-ESS permission (H1 lists no own salary history).
insert into permission (resource, action, field_group) values ('increment', 'read', 'reason');
