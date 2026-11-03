-- 0040 Document quarantine, scanning and verification (FR-106; H4 "Upload category and file"; H3 TN05; DF06 v8.2;
-- BR-053). Every user upload (employee documents, expense receipts, change evidence) is quarantined until a malware
-- scan releases it: PENDING_SCAN -> CLEAN, or QUARANTINED when the scan finds something. Only CLEAN content is ever
-- served. A document becomes verified master evidence only through an independent reviewer's verification of a
-- CLEAN file. System-generated files and import sheets are not user documents and carry no scan state.

alter table attachment add column scan_state text check (scan_state in ('PENDING_SCAN', 'CLEAN', 'QUARANTINED'));
alter table attachment add column scan_checked_at timestamptz;
alter table attachment add column scan_finding text check (scan_finding is null or scan_finding ~ '^[A-Za-z0-9._:/ -]{1,200}$');
alter table attachment add constraint attachment_scan_checked check ((scan_state in ('CLEAN', 'QUARANTINED')) = (scan_checked_at is not null));
alter table attachment add constraint attachment_scan_finding check (scan_finding is null or scan_state = 'QUARANTINED');

-- Files uploaded before scanning existed were never scanned: they wait for the scanner like any new upload.
update attachment a set scan_state = 'PENDING_SCAN'
 where exists (select 1 from employee_document d where d.company_id = a.company_id and d.attachment_id = a.id)
    or exists (select 1 from expense_receipt r where r.company_id = a.company_id and r.attachment_id = a.id);
create index attachment_pending_scan_idx on attachment (company_id, created_at) where (scan_state = 'PENDING_SCAN');

-- A scan verdict is final: a released or quarantined file never goes back to pending or changes verdict.
create function hrms_attachment_scan_guard() returns trigger language plpgsql as $$
begin
  if old.scan_state is distinct from new.scan_state and old.scan_state is not null and old.scan_state <> 'PENDING_SCAN' then
    raise exception 'a scan verdict is final' using errcode = '23514';
  end if;
  if old.scan_state is null and new.scan_state is not null then
    raise exception 'a file not subject to scanning cannot be put into quarantine afterwards' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger attachment_scan_guard before update of scan_state on attachment for each row execute function hrms_attachment_scan_guard();

-- Verification of an employee document as master evidence.
alter table employee_document add column verification_state text not null default 'UNVERIFIED'
  check (verification_state in ('UNVERIFIED', 'VERIFIED', 'REJECTED'));
alter table employee_document add column verified_by uuid references user_account (id) on delete restrict;
alter table employee_document add column verified_at timestamptz;
alter table employee_document add column verification_note text check (verification_note is null or (btrim(verification_note) <> '' and length(verification_note) <= 1000));
alter table employee_document add constraint employee_document_verification_actor
  check ((verification_state = 'UNVERIFIED') = (verified_by is null and verified_at is null));
alter table employee_document add constraint employee_document_rejection_note
  check (verification_state <> 'REJECTED' or verification_note is not null);

-- Verified only if the file is CLEAN, never by the person who uploaded it, and the verdict is final.
create function hrms_document_verification_guard() returns trigger language plpgsql as $$
declare
  a attachment%rowtype;
begin
  if new.verification_state is not distinct from old.verification_state then
    return new;
  end if;
  if old.verification_state <> 'UNVERIFIED' then
    raise exception 'a document verification is final' using errcode = '23514';
  end if;
  select * into a from attachment where company_id = new.company_id and id = new.attachment_id;
  if a.scan_state is distinct from 'CLEAN' then
    raise exception 'only a released (scanned clean) file can be verified' using errcode = '23514';
  end if;
  if a.owner_user_id = new.verified_by then
    raise exception 'the uploader cannot verify their own upload' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger employee_document_verification_guard before update of verification_state on employee_document
  for each row execute function hrms_document_verification_guard();

insert into permission (resource, action, field_group) values ('document', 'verify', 'document');
