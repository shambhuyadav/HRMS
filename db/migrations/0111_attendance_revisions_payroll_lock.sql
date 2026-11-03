-- 0111 Attendance result history and the processed-payroll lock (FR-021 "policy and amendment-log views identify why the
-- daily status changed"; FR-022 "payroll-lock dependencies"; DB026; DB027; BR-037; BR-047; ZT36; Appendix B).
--
-- Revisions. A daily result (attendance_record) is overwritten when a reprocessing or an amendment changes it. Before
-- that, its values are copied to an append-only revision with the cause (the processing job or the amendment), the actor
-- and the time, so a result can always be traced back. A change of the result without its revision is refused.
--
-- Lock. Payroll calculation turns attendance into loss of pay, and processing freezes the records (0043). A day a frozen,
-- calculated record of the employee covers, up to the business date the record was frozen (the record cannot have used a
-- later day: a run may be processed before its month ends), is final: BR-037 "locked historical results are not silently
-- rewritten". Processing skips it with a count and an amendment is refused (attendance/service.ts); a correction after
-- that is a linked adjustment, which waits for the owner's closed-period treatment (BR-047, FR-035, FR-100). The source
-- punches stay as they arrived.

create table attendance_record_revision (
  id                     uuid primary key default gen_random_uuid(),
  company_id             uuid not null references company (id) on delete restrict,
  attendance_record_id   uuid not null,
  -- The record's version these values belonged to.
  prior_version          integer not null check (prior_version > 0),
  shift_id               uuid,
  policy_id              uuid not null,
  scheduled_net_minutes  integer not null,
  worked_minutes         integer not null,
  late                   boolean not null,
  early_departure        boolean not null,
  status_category        text not null default 'ATTENDANCE_STATUS' check (status_category = 'ATTENDANCE_STATUS'),
  status_id              uuid not null,
  exception_code         text,
  amended                boolean not null,
  calculation_count      integer not null,
  cause                  text not null check (cause in ('PROCESSING', 'AMENDMENT')),
  bulk_job_id            uuid,
  amendment_id           uuid,
  actor_id               uuid not null references user_account (id) on delete restrict,
  occurred_at            timestamptz not null default now(),
  created_at             timestamptz not null default now(),
  created_by             uuid references user_account (id) on delete restrict,
  unique (company_id, id),
  unique (company_id, attendance_record_id, prior_version),
  foreign key (company_id, attendance_record_id) references attendance_record (company_id, id) on delete restrict,
  foreign key (company_id, shift_id) references shift (company_id, id) on delete restrict,
  foreign key (company_id, policy_id) references attendance_policy (company_id, id) on delete restrict,
  foreign key (company_id, status_category, status_id) references reference_value (company_id, category, id) on delete restrict,
  foreign key (company_id, bulk_job_id) references bulk_job (company_id, id) on delete restrict,
  foreign key (company_id, amendment_id) references attendance_amendment (company_id, id) on delete restrict,
  check ((cause = 'PROCESSING') = (bulk_job_id is not null)),
  check ((cause = 'AMENDMENT') = (amendment_id is not null))
);
create trigger attendance_record_revision_append_only before update or delete on attendance_record_revision
  for each row execute function hrms_append_only();
create trigger attendance_record_revision_job_kind before insert on attendance_record_revision
  for each row execute function hrms_bulk_job_row_kind('ATTENDANCE_PROCESSING');

-- A day of this employee that a frozen payroll record used.
create function hrms_attendance_day_frozen(p_company uuid, p_employee uuid, p_day date) returns boolean language sql stable as $$
  select exists (
    select 1 from payroll_record r
     where r.company_id = p_company and r.employee_id = p_employee and r.eligible_from <= p_day and r.eligible_to >= p_day
       and r.frozen_at is not null and r.calculation_status = 'CALCULATED' and p_day <= hrms_business_date(r.company_id, r.frozen_at))
$$;

create function hrms_attendance_record_guard() returns trigger language plpgsql as $$
begin
  if (new.shift_id, new.policy_id, new.scheduled_net_minutes, new.worked_minutes, new.late, new.early_departure, new.status_id, new.exception_code, new.amended)
     is distinct from
     (old.shift_id, old.policy_id, old.scheduled_net_minutes, old.worked_minutes, old.late, old.early_departure, old.status_id, old.exception_code, old.amended) then
    if hrms_attendance_day_frozen(old.company_id, old.employee_id, old.work_date) then
      raise exception 'attendance of % is used by a processed payroll', old.work_date using errcode = '23514';
    end if;
    if not exists (select 1 from attendance_record_revision v where v.company_id = old.company_id and v.attendance_record_id = old.id and v.prior_version = old.version) then
      raise exception 'an attendance result changes only with its revision' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger attendance_record_guard before update on attendance_record for each row execute function hrms_attendance_record_guard();
