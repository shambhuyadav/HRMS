-- 0087 Opening-balance upload and the mapped-policy export (FR-024; FR-025; E06; DF09; I-13).
-- A batch import has its own duty, next to the duty its rows are applied under (leave.adjust), as every import does; the
-- mapped-policy export is a report export like every other, so it has its own export permission on its resource (0015,
-- 0067). Both are operational (leave type, units and policy parameters are, DF02) and HR Administrator default duties
-- (access/baseline.ts).
insert into permission (resource, action, field_group) values
  ('leave',        'import', 'operational'),
  ('leave_policy', 'export', 'operational');
