-- 0141 State paths and write-once fields of the earlier resources (BRD line 80 "explicit controlled status and transition
-- definitions for each resource"; CI15; CI16; C4; ZT10). Later resources have their own guards; these had only a CHECK on the state's
-- membership, so a direct write could bring back a rejected link or reopen a committed import. Triggers apply to later writes
-- only: no stored row is read or changed here, so a database with existing rows always upgrades.

-- The transitions a table allows are its trigger's arguments, each written 'FROM>TO'. A write leaving the state alone passes.
create function hrms_state_path() returns trigger language plpgsql as $$
begin
  if new.state is distinct from old.state and not ((old.state || '>' || new.state) = any (tg_argv)) then
    raise exception '% cannot move from % to %', tg_table_name, old.state, new.state using errcode = '23514';
  end if;
  return new;
end $$;

-- Columns named as arguments never change.
create function hrms_columns_fixed() returns trigger language plpgsql as $$
declare
  c text;
  before_row jsonb := to_jsonb(old);
  after_row jsonb := to_jsonb(new);
begin
  foreach c in array tg_argv loop
    if before_row -> c is distinct from after_row -> c then
      raise exception '%.% is fixed once written', tg_table_name, c using errcode = '23514';
    end if;
  end loop;
  return new;
end $$;

-- Columns named as arguments may be filled once; after that they never change.
create function hrms_columns_set_once() returns trigger language plpgsql as $$
declare
  c text;
  before_row jsonb := to_jsonb(old);
  after_row jsonb := to_jsonb(new);
begin
  foreach c in array tg_argv loop
    if before_row ->> c is not null and before_row -> c is distinct from after_row -> c then
      raise exception '%.% is final once recorded', tg_table_name, c using errcode = '23514';
    end if;
  end loop;
  return new;
end $$;

-- A mobile app link (FR-023): decided once, and a decided link never comes back. Replacing an active link revokes it.
create trigger mobile_app_link_state_path before update on mobile_app_link for each row
  execute function hrms_state_path('PENDING>ACTIVE', 'PENDING>REJECTED', 'ACTIVE>REVOKED');
create trigger mobile_app_link_fixed before update on mobile_app_link for each row
  execute function hrms_columns_fixed('employee_id', 'app_account_ref', 'requested_by', 'replaces_link_id');
create trigger mobile_app_link_set_once before update on mobile_app_link for each row
  execute function hrms_columns_set_once('decided_by', 'decided_at', 'revoked_by', 'revoked_at', 'revoke_reason');

-- A retention rule never changes its values: a new value is a new revision. Activation is independent of the author (C4).
create trigger retention_rule_state_path before update on retention_rule for each row
  execute function hrms_state_path('DRAFT>ACTIVE', 'ACTIVE>RETIRED');
create trigger retention_rule_fixed before update on retention_rule for each row
  execute function hrms_columns_fixed('resource_code', 'revision', 'retain_days', 'basis_note');
create trigger retention_rule_set_once before update on retention_rule for each row
  execute function hrms_columns_set_once('approved_by', 'approved_at');

-- A retention hold: decided once, released once, and what it holds and why never change.
create trigger retention_hold_state_path before update on retention_hold for each row
  execute function hrms_state_path('PENDING>ACTIVE', 'PENDING>REJECTED', 'ACTIVE>RELEASED');
create trigger retention_hold_fixed before update on retention_hold for each row
  execute function hrms_columns_fixed('resource_code', 'record_key', 'reason', 'requested_by');
create trigger retention_hold_set_once before update on retention_hold for each row
  execute function hrms_columns_set_once('decided_by', 'decided_at', 'released_by', 'released_at', 'release_reason');

-- An expense policy: 0116 froze what follows activation. A draft that was never activated cannot be retired either.
create trigger expense_policy_state_path before update on expense_policy for each row
  execute function hrms_state_path('DRAFT>ACTIVE', 'ACTIVE>RETIRED');

-- An import job only moves forward, and COMMITTED, REJECTED and CANCELLED are final (VALIDATED and COMMITTING exist in the
-- schema and are unused by the service; the forward moves through them stay open).
create trigger import_job_state_path before update on import_job for each row
  execute function hrms_state_path(
    'UPLOADED>VALIDATED', 'UPLOADED>PREVIEWED', 'UPLOADED>COMMITTING', 'UPLOADED>COMMITTED', 'UPLOADED>REJECTED', 'UPLOADED>CANCELLED',
    'VALIDATED>PREVIEWED', 'VALIDATED>COMMITTING', 'VALIDATED>COMMITTED', 'VALIDATED>REJECTED', 'VALIDATED>CANCELLED',
    'PREVIEWED>COMMITTING', 'PREVIEWED>COMMITTED', 'PREVIEWED>REJECTED', 'PREVIEWED>CANCELLED',
    'COMMITTING>COMMITTED', 'COMMITTING>REJECTED', 'COMMITTING>CANCELLED');
create trigger import_job_fixed before update on import_job for each row
  execute function hrms_columns_fixed('kind', 'attachment_id', 'submitted_by', 'idempotency_key');

-- The rows of a finished job are its record (CI16: its counts reconcile to them), so they no longer change and none is added.
create function hrms_import_row_job_open() returns trigger language plpgsql as $$
begin
  if exists (select 1 from import_job where company_id = new.company_id and id = new.job_id and state in ('COMMITTED', 'REJECTED', 'CANCELLED')) then
    raise exception 'the rows of a finished import job do not change' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger import_row_job_open before insert or update on import_row for each row execute function hrms_import_row_job_open();

-- A report: RUNNING>QUEUED is the retry 0097 and 0122 define (the attempt failed, it waits, it runs again). An ended one stays ended.
create trigger report_execution_state_path before update on report_execution for each row
  execute function hrms_state_path('QUEUED>RUNNING', 'QUEUED>FAILED', 'RUNNING>QUEUED', 'RUNNING>COMPLETED', 'RUNNING>FAILED', 'COMPLETED>EXPIRED');

-- A notification: DELIVERED, FAILED and SUPPRESSED are final.
create trigger notification_state_path before update on notification for each row
  execute function hrms_state_path('QUEUED>DELIVERED', 'QUEUED>RETRY_PENDING', 'QUEUED>FAILED', 'QUEUED>SUPPRESSED',
                                   'RETRY_PENDING>DELIVERED', 'RETRY_PENDING>FAILED', 'RETRY_PENDING>SUPPRESSED');

-- A biometric run that ended is final as a whole, counts included: a page can no longer be committed to it (FR-088).
create function hrms_biometric_run_final() returns trigger language plpgsql as $$
begin
  if old.state <> 'RUNNING' then
    raise exception 'a biometric sync run that has ended does not change' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger biometric_sync_run_final before update on biometric_sync_run for each row execute function hrms_biometric_run_final();
