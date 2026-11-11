-- 0283 Absconding warnings and the absconding audit report (BRD coverage CL-052 "Absconding Audit Report", under FR-018 restricted
-- notes and warnings, FR-056 to FR-058 reports; BR-026; BR-044; BR-045; DF02). Built 11 Nov 2026 from the reference system's screen
-- (filters: company and "warning issued from" date; the absconding warnings issued: employee, date, type, by whom); decided under owner
-- delegation, 6 Nov 2026.
--
-- 0260 made WARNING one of the register's fixed note types, but a warning said nothing about why it was given, so an absconding
-- warning could not be told from any other. A warning now carries an optional category; ABSCONDING is the only one so far (a warning
-- for staying away from work without leave or word). It is chosen when the warning is written (on screen, or in the notes bulk upload
-- as the type "Absconding warning") and, like everything on a note, never changed afterwards: a corrected warning is a new note with
-- its own category (0038), a withdrawn one is voided (0260). Earlier warnings have no category and are not absconding warnings.
--
-- employee_note.export.restricted   the report shows who was warned when and by whom, derived from restricted notes (DF02), so it is a
--                                   confidential export right (BR-045), ceiling only for the HR Administrator, never a default duty.
--                                   The note text is never in the report.
--
-- To reverse: drop the report from the catalogue, then the permission and ceilings, the index, the constraint and the column.

alter table employee_note
  add column warning_category text check (warning_category in ('ABSCONDING')),
  add constraint employee_note_warning_category_kind check (warning_category is null or note_kind = 'WARNING');
create index employee_note_absconding_idx on employee_note (company_id, note_date) where (warning_category = 'ABSCONDING');

insert into permission (resource, action, field_group) values ('employee_note', 'export', 'restricted') on conflict do nothing;

-- Ceilings of every company's HR Administrator role (new companies get it from modules/lifecycle/absconding-registration.ts). A ceiling
-- grants nothing by itself: an assignment holds the group only through an independently approved grant.
insert into role_permission (company_id, role_id, permission_id, effect)
select r.company_id, r.id, p.id, 'ALLOW'
  from role r
  join permission p on p.resource = 'employee_note' and p.action = 'export' and p.field_group = 'restricted'
 where r.code = 'HR_ADMINISTRATOR'
on conflict (company_id, role_id, permission_id) do nothing;
