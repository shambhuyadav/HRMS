-- 0260 Employee notes register: exit notes, remarks and warnings (BRD coverage CL-040 "ELC and Letters -> Exit Notes/Remarks/
-- Warnings", under FR-015 to FR-018; FR-018 "Restrict notes and warnings to authorised HR roles", acceptance "unauthorised users
-- cannot view restricted remarks"; BR-044; DF08; DF09; FR-106). Built 10 Nov 2026 from the reference screen's structure (New, Bulk
-- upload, filters date range and type, search employee / code / submitted by / status); decided under owner delegation, 6 Nov 2026.
--
-- The register extends the restricted notes of 0038 instead of adding a second store, so one note has one home:
--   * Types: the reference screen's six (Appreciation, Exit note, Offer rejection, PIP, Remarks, Warning) as a fixed list, not
--     company reference values: the application reads them (the absconding audit report, CL-052, counts warnings), and a type a
--     company renamed or retired would silently change what such a report counts. NOTE stays for notes written before (0038).
--   * note_date: the day the note is about (the reference's "Date"); it may be before the day it is written, never after it.
--     Existing notes take the company-local day they were written.
--   * attachment_id: an optional supporting file of the same employee, through the shared attachment framework: quarantined until
--     the malware scan releases it and served only when CLEAN (FR-106).
--   * source: ENTRY (written on screen) or IMPORT (the bulk upload, imports/ framework, all or nothing).
--   * Status, derived, never stored: ACTIVE; SUPERSEDED when a later note corrects it (0038); VOIDED when it was withdrawn with a
--     reason (employee_note_void below). Nothing is edited or deleted: a void is a row of its own, once per note; a corrected note
--     is not voided (its correction is) and a voided note is not corrected.
--   * Permissions: voiding and the bulk upload are rights of their own (employee_note.void.restricted, employee_note.import.
--     restricted), confidential and ceiling only for the HR Administrator (BR-044: an eligible Admin assignment, approved per
--     assignment). The register reads with employee_note.read.restricted (0038), within row scope, never one's own record.
--
-- To reverse: refuse the new kinds and voids in the service; once none exists, drop the void table, the columns, triggers and
-- permissions added here and restore the 0038 kind check.

alter table employee_note drop constraint employee_note_note_kind_check;
alter table employee_note add constraint employee_note_note_kind_check
  check (note_kind in ('NOTE', 'REMARK', 'WARNING', 'APPRECIATION', 'EXIT_NOTE', 'OFFER_REJECTION', 'PIP'));

alter table employee_note add column note_date date;
alter table employee_note add column attachment_id uuid;
alter table employee_note add column source text not null default 'ENTRY' check (source in ('ENTRY', 'IMPORT'));
alter table employee_note disable trigger employee_note_append_only;
update employee_note set note_date = hrms_business_date(company_id, created_at);
alter table employee_note enable trigger employee_note_append_only;
alter table employee_note
  alter column note_date set not null,
  add constraint employee_note_attachment_fk foreign key (company_id, attachment_id, employee_id) references attachment (company_id, id, employee_id) on delete restrict;
-- One note per supporting file: a file is never shared between notes.
create unique index employee_note_one_attachment on employee_note (company_id, attachment_id) where (attachment_id is not null);
-- The register's default order and its date range filter.
create index employee_note_register_idx on employee_note (company_id, note_date desc, created_at desc);

-- A void withdraws a note with a reason (DF08): the note and the void both stay.
create table employee_note_void (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references company (id) on delete restrict,
  note_id              uuid not null,
  employee_id          uuid not null,
  reason               text not null check (btrim(reason) <> '' and length(reason) <= 1000),
  voided_at            timestamptz not null default now(),
  voided_by            uuid not null references user_account (id) on delete restrict,
  acting_assignment_id uuid not null,
  unique (company_id, id),
  unique (company_id, note_id),
  foreign key (company_id, note_id, employee_id) references employee_note (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, acting_assignment_id) references role_assignment (company_id, id) on delete restrict
);
create index employee_note_void_employee_idx on employee_note_void (company_id, employee_id);
create trigger employee_note_void_append_only before update or delete on employee_note_void for each row execute function hrms_append_only();

-- A corrected note is not voided: its correction is the note in force.
create function hrms_employee_note_void_guard() returns trigger language plpgsql as $$
begin
  if exists (select 1 from employee_note s where s.company_id = new.company_id and s.supersedes_note_id = new.note_id) then
    raise exception 'a corrected note cannot be voided; void its correction instead' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger employee_note_void_guard before insert on employee_note_void for each row execute function hrms_employee_note_void_guard();

-- A new note: never dated after the company's business day, and never the correction of a voided note.
create function hrms_employee_note_insert_guard() returns trigger language plpgsql as $$
begin
  if new.note_date > hrms_business_date(new.company_id, now()) then
    raise exception 'a note cannot be dated after today' using errcode = '23514';
  end if;
  if new.supersedes_note_id is not null
     and exists (select 1 from employee_note_void v where v.company_id = new.company_id and v.note_id = new.supersedes_note_id) then
    raise exception 'a voided note cannot be corrected' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger employee_note_insert_guard before insert on employee_note for each row execute function hrms_employee_note_insert_guard();

insert into permission (resource, action, field_group) values
  ('employee_note', 'void', 'restricted'),
  ('employee_note', 'import', 'restricted')
on conflict do nothing;

-- Ceilings of every company's HR Administrator role (new companies get them from modules/lifecycle/registration.ts). A ceiling
-- grants nothing by itself: an assignment holds the group only through an independently approved grant.
insert into role_permission (company_id, role_id, permission_id, effect)
select r.company_id, r.id, p.id, 'ALLOW'
  from role r
  join permission p on p.resource = 'employee_note' and p.action in ('void', 'import') and p.field_group = 'restricted'
 where r.code = 'HR_ADMINISTRATOR'
on conflict (company_id, role_id, permission_id) do nothing;
