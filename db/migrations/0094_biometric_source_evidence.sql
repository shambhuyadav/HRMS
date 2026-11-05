-- 0094 Source evidence of quarantined biometric observations (FR-087 "preserve source evidence"; BR-036; DF13).
-- An observation kept only a fingerprint, so a conflicting repeat or an ambiguous local time could not be read back: the
-- monitor had nothing to show and a correction nothing to check. Normalised fields only, never the raw record or a template.
alter table biometric_run_observation
  add column source_evidence jsonb check (source_evidence is null or jsonb_typeof(source_evidence) = 'object');

-- The Sync Monitor's lists, newest first (FR-056 paging).
create index biometric_run_observation_exception_idx on biometric_run_observation (company_id, created_at desc, id)
  where outcome in ('REJECTED', 'QUARANTINED');
create index biometric_sync_run_started_idx on biometric_sync_run (company_id, started_at desc, id);
