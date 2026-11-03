-- 0119 Settlement export right (FR-054, FR-002 "view, create, amend, submit, approve, export ... rights separately for
-- each module", FR-065, FR-066; DF02).
-- GET /v1/settlements/:id/export and GET /v1/settlements/export-archive answered to settlement.read.amount, the grant
-- every settlement reviewer and approver needs to open a settlement, so reading one for review also allowed a bulk
-- export of compensation amounts. Every other confidential export has its own export permission (0069 payroll reports,
-- the report catalogue's <resource>.export). Like the other settlement amount duties it is a ceiling-only grant of the
-- HR Administrator role (modules/lifecycle/registration.ts), approved per assignment, never a default duty: an
-- assignment holding only settlement.read.amount no longer exports until the export grant is approved for it.
insert into permission (resource, action, field_group) values ('settlement', 'export', 'amount');
