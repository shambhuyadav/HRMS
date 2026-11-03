-- 0041 Proposed changes per import row (FR-009: an update import shows the proposed changes before an authorised
-- commit). Operational values only, as field -> { from, to }; creation imports leave it empty.
alter table import_row add column proposed_changes jsonb
  check (proposed_changes is null or (jsonb_typeof(proposed_changes) = 'object' and proposed_changes <> '{}'::jsonb));
