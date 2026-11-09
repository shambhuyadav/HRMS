-- 0192 Approved searchable CV content (FR-013 "Search CV metadata and approved searchable content"; DF02; DF08; FR-106).
-- Decided under owner delegation, 6 Nov 2026 (docs/03 I-82 item 4, answering I-40 item 7). Synthetic data only.
--
-- Searchable content is the text of one released (malware-scan CLEAN) CV document that an eligible Admin holding the
-- confidential document grant (candidate.upload.document) has approved for search, for a candidate whose consent is GIVEN.
-- Nothing becomes searchable on upload. The text is either typed or pasted by that Admin from the released file
-- (TRANSCRIBED), or produced by a text-extraction component once one is approved and configured (EXTRACTED; none is: the
-- application has a plug point only, hiring/cv-text.ts). The search (candidate.read.document) matches approved text only,
-- excludes a candidate whose consent is no longer GIVEN or whose retention date has passed, and never returns the text.
-- One approved text per document; approving a new one revokes the previous, and a revocation keeps the row with its reason.
create table candidate_cv_text (
  id                      uuid primary key default gen_random_uuid(),
  company_id              uuid not null references company (id) on delete restrict,
  candidate_id            uuid not null,
  candidate_document_id   uuid not null,
  source                  text not null check (source in ('TRANSCRIBED', 'EXTRACTED')),
  content                 text not null check (btrim(content) <> '' and length(content) <= 100000),
  search_vector           tsvector generated always as (to_tsvector('simple'::regconfig, content)) stored,
  -- The released file the text was approved against.
  document_checksum       text not null check (document_checksum ~ '^[0-9a-f]{64}$'),
  state                   text not null check (state in ('APPROVED', 'REVOKED')),
  approved_by             uuid not null references user_account (id) on delete restrict,
  approved_assignment_id  uuid not null,
  approved_at             timestamptz not null default now(),
  revoked_by              uuid references user_account (id) on delete restrict,
  revoked_at              timestamptz,
  revocation_reason       text check (revocation_reason is null or (btrim(revocation_reason) <> '' and length(revocation_reason) <= 500)),
  created_at              timestamptz not null default now(),
  created_by              uuid references user_account (id) on delete restrict,
  updated_at              timestamptz not null default now(),
  updated_by              uuid references user_account (id) on delete restrict,
  version                 integer not null default 1 check (version > 0),
  unique (company_id, id),
  foreign key (company_id, candidate_document_id, candidate_id) references candidate_document (company_id, id, candidate_id) on delete restrict,
  foreign key (company_id, approved_assignment_id) references role_assignment (company_id, id) on delete restrict,
  check ((state = 'REVOKED') = (revoked_at is not null and revoked_by is not null and revocation_reason is not null))
);
create unique index candidate_cv_text_one_approved on candidate_cv_text (company_id, candidate_document_id) where (state = 'APPROVED');
create index candidate_cv_text_candidate_idx on candidate_cv_text (company_id, candidate_id);
create index candidate_cv_text_search_idx on candidate_cv_text using gin (search_vector) where (state = 'APPROVED');

-- Approved text is fixed; its one change is a revocation, which is final.
create function hrms_candidate_cv_text_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.state <> 'APPROVED' then
      raise exception 'searchable CV text starts approved' using errcode = '23514';
    end if;
    return new;
  end if;
  if (new.candidate_id, new.candidate_document_id, new.source, new.content, new.document_checksum, new.approved_by, new.approved_assignment_id, new.approved_at)
     is distinct from
     (old.candidate_id, old.candidate_document_id, old.source, old.content, old.document_checksum, old.approved_by, old.approved_assignment_id, old.approved_at) then
    raise exception 'approved CV text is immutable; approve a new text instead' using errcode = '23514';
  end if;
  if old.state = 'REVOKED' then
    raise exception 'a revoked CV text stays revoked' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger candidate_cv_text_guard before insert or update on candidate_cv_text for each row execute function hrms_candidate_cv_text_guard();
create trigger candidate_cv_text_touch before update on candidate_cv_text for each row execute function hrms_touch();
create trigger candidate_cv_text_no_delete before delete on candidate_cv_text for each row execute function hrms_no_delete();
