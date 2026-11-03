-- 0086 One opening balance per employee and leave type (FR-025 "duplicate opening-balance batches are blocked"; ZT07).
-- The API checks for an existing opening under the balance lock; this is the database's own refusal for any other path,
-- so two concurrent openings can never double an entitlement. If a database already holds a duplicate, this migration
-- fails and names it: the extra movement has to be resolved by HR (movements are append-only), never silently dropped.
create unique index leave_movement_one_opening_uq on leave_movement (company_id, employee_id, leave_type_id) where (movement_kind = 'OPENING');
