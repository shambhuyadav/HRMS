-- 0196 Dated reporting settings and the operational claim-state list (I-83; decided under owner delegation, 6 Nov 2026;
-- BR-045; FR-096; FR-097; DF17; FR-038; I-62 items 4 and 5; I-74 items 2, 3 and 8).
--
-- 1. reporting_setting: one dated revision per period and company, changed by HR (reporting_setting.manage), never in place.
--    small_count_threshold     BR-045 "redaction must prevent inference": a dashboard people-count the viewer cannot open
--                              record by record in the same assignment is shown as "fewer than N" while it is between 1 and
--                              N - 1 (zero stays zero, DF17 "zero means no eligible records"). 1 switches suppression off.
--    recent_activity_days      DF17 "recent operational activity": how far back the dashboard lists the selected
--                              assignment's own recorded actions.
--    salary_progression_years  FR-038 salary progression chart: the default span in financial years.
--    Values never change; a revision only gets its end date, when the next one starts (the route closes it). Each company
--    starts with one revision from 2000-01-01 holding the delegated defaults (5, 14, 5), written by the system actor;
--    provisioning gives a new company the same (modules/reporting/settings.ts).
-- 2. Permissions, operational and in the catalogue:
--    reporting_setting.manage  a default duty of new HR Administrator assignments (operational configuration, like the expense
--                              policy); existing approved assignments keep their frozen allowlists (0099), so an existing HR
--                              assignment needs a new approved grant to change the settings.
--    expense_state.read        GET /v1/expense/claim-states: claim identity, claimant, state, step and exception mark, never
--                              amounts, purpose, merchant, receipts or reasons (DF02). A default duty of new Finance Reviewer and
--                              Expense Finance Approver assignments: the readable list behind their dashboard figures (I-62 item 4).
--    Both resources are classified OPERATIONAL in existing companies under their employee operational policy's approver and
--    date, as provisioning does for a new company (BR-043: an unclassified group is confidential).
create table reporting_setting (
  id                         uuid primary key default gen_random_uuid(),
  company_id                 uuid not null references company (id) on delete restrict,
  effective_from             date not null,
  effective_to               date check (effective_to > effective_from),
  small_count_threshold      integer not null check (small_count_threshold between 1 and 100),
  recent_activity_days       integer not null check (recent_activity_days between 1 and 366),
  salary_progression_years   integer not null check (salary_progression_years between 1 and 20),
  reason                     text not null check (btrim(reason) <> '' and length(reason) <= 1000),
  created_at                 timestamptz not null default now(),
  created_by                 uuid not null references user_account (id) on delete restrict,
  updated_at                 timestamptz not null default now(),
  updated_by                 uuid references user_account (id) on delete restrict,
  version                    integer not null default 1 check (version > 0),
  unique (company_id, id),
  exclude using gist (company_id with =, daterange(effective_from, effective_to, '[)') with &&)
);

-- A revision's values and start never change, and an end date, once set, stays: the next revision is a new row.
create function hrms_reporting_setting_frozen() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'reporting settings are kept; close a revision by starting the next one' using errcode = '23514';
  end if;
  if (new.company_id, new.effective_from, new.small_count_threshold, new.recent_activity_days, new.salary_progression_years, new.reason, new.created_by, new.created_at)
     is distinct from (old.company_id, old.effective_from, old.small_count_threshold, old.recent_activity_days, old.salary_progression_years, old.reason, old.created_by, old.created_at)
     or (old.effective_to is not null and new.effective_to is distinct from old.effective_to) then
    raise exception 'a reporting setting revision is fixed; only an open revision may be given its end date' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger reporting_setting_frozen before update or delete on reporting_setting for each row execute function hrms_reporting_setting_frozen();
create trigger reporting_setting_touch before update on reporting_setting for each row execute function hrms_touch();

insert into reporting_setting (company_id, effective_from, small_count_threshold, recent_activity_days, salary_progression_years, reason, created_by)
select c.id, '2000-01-01', 5, 14, 5, 'Initial values decided under owner delegation, 6 Nov 2026 (I-83)', '00000000-0000-4000-8000-000000000001'
  from company c
 where not exists (select 1 from reporting_setting s where s.company_id = c.id);

-- DF17 recent activity reads the audit trail by acting assignment, newest first (modules/reporting/activity.ts).
create index audit_event_acting_assignment_idx on audit_event (company_id, acting_assignment_id, occurred_at) where acting_assignment_id is not null;

insert into permission (resource, action, field_group) values
  ('reporting_setting', 'manage', 'operational'),
  ('expense_state', 'read', 'operational')
on conflict do nothing;

insert into role_permission (company_id, role_id, permission_id, effect)
select r.company_id, r.id, p.id, 'ALLOW'
  from role r
  join permission p on (r.code, p.resource, p.action, p.field_group) in (
    ('HR_ADMINISTRATOR', 'reporting_setting', 'manage', 'operational'),
    ('FINANCE_REVIEWER', 'expense_state', 'read', 'operational'),
    ('EXPENSE_FINANCE_APPROVER', 'expense_state', 'read', 'operational'))
on conflict (company_id, role_id, permission_id) do nothing;

insert into confidential_field_policy (company_id, resource_code, field_group, classification, effective_from, approved_by, approved_at, created_by)
select cfp.company_id, g.resource_code, 'operational', 'OPERATIONAL', cfp.effective_from, cfp.approved_by, now(), cfp.approved_by
  from confidential_field_policy cfp
 cross join (values ('reporting_setting'), ('expense_state')) as g (resource_code)
 where cfp.resource_code = 'employee' and cfp.field_group = 'operational' and cfp.effective_to is null
   and not exists (select 1 from confidential_field_policy x where x.company_id = cfp.company_id and x.resource_code = g.resource_code and x.field_group = 'operational');
