-- 0056 Discarding a staged bulk document; listing a user's import jobs (FR-010; FR-106; DF08; DF09).
-- A staged document that is not mapped yet (one the malware scan quarantined, or one staged by mistake) can be
-- discarded by its uploader. DF08: an unsubmitted draft may be cancelled and is retained; no hard delete or purge
-- runs until a separately documented retention schedule exists. So a discarded upload stays on record, with its
-- attachment, as DISCARDED: it frees its file name for a new upload, can never be mapped, and is final. A mapped upload
-- is an employee document and cannot be discarded (it was already final).

alter table document_bulk_upload drop constraint document_bulk_upload_state_check;
alter table document_bulk_upload add constraint document_bulk_upload_state_check check (state in ('UNMAPPED', 'MAPPED', 'DISCARDED'));
alter table document_bulk_upload add column discarded_at timestamptz;
alter table document_bulk_upload add constraint document_bulk_upload_discarded_check check ((state = 'DISCARDED') = (discarded_at is not null));

-- As before (kept on record, file and uploader fixed, a mapping final), and a discard is final too.
create or replace function hrms_document_bulk_upload_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'staged documents are kept on record' using errcode = '23514';
  end if;
  if (new.company_id, new.attachment_id, new.uploaded_by, new.file_name) is distinct from (old.company_id, old.attachment_id, old.uploaded_by, old.file_name) then
    raise exception 'the file and uploader of a staged document are fixed' using errcode = '23514';
  end if;
  if old.state = 'MAPPED' and (new.state, new.mapped_document_id, new.mapped_at) is distinct from (old.state, old.mapped_document_id, old.mapped_at) then
    raise exception 'a mapped document is final' using errcode = '23514';
  end if;
  if old.state = 'DISCARDED' and (new.state, new.mapped_document_id, new.mapped_at, new.discarded_at) is distinct from (old.state, old.mapped_document_id, old.mapped_at, old.discarded_at) then
    raise exception 'a discarded staged document is final' using errcode = '23514';
  end if;
  return new;
end $$;

-- An import job is listed to its submitter only, newest first (imports/jobs.ts listJobs).
create index import_job_submitter on import_job (company_id, submitted_by, kind, created_at desc);
