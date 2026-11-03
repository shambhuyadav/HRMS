-- 0055 Increment review opening as a bulk job (NFR-S09; FR-091; DF15; ADR-15). Opening a cycle review for a year or a
-- month loops over every employee of the company, so it no longer runs on the request: the request checks the cycle
-- and the period as before, records a QUEUED bulk_job of kind INCREMENT_REVIEW_OPENING and answers 202; the worker
-- opens the roster in bounded chunks in employee-code order (modules/increment/roster.ts openReviewChunk), and the
-- increment_review_run row and the OPEN_REVIEW audit are written once, with the last chunk.
alter table bulk_job drop constraint bulk_job_kind_check;
alter table bulk_job add constraint bulk_job_kind_check check (kind in ('ATTENDANCE_PROCESSING', 'LEAVE_ACCRUAL', 'INCREMENT_REVIEW_OPENING'));
