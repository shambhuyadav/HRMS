-- 0270 Payroll inputs and reports, batch R3 (BRD coverage CL-074, CL-081, CL-084, CL-085, CL-097, CL-098, CL-100, CL-113, CL-119
-- under FR-028 to FR-039; built 11 Nov 2026 from the reference system's screens; decided under owner delegation, 6 Nov 2026). The
-- module is modules/payroll-extras. Nothing here values tax or any statutory amount: statutory packs stay as they are (inactive until
-- an authorised person activates them), and every figure a report cannot work out from configured rules reads NOT_CONFIGURED.
--
-- 1. payroll_challan_setting (CL-074 challan master): the company's deposit particulars per statute (TDS: the TAN; PF and ESIC: the
--    establishment code; the bank, its branch and BSR code). Dated revisions, append-only: the revision in force on a day is the
--    latest effective on or before it (the highest revision among those of the same date), so a correction is a new revision.
-- 2. payroll_tds_challan (CL-081): a TDS deposit as the bank's challan states it (BSR code, deposit date, challan serial number),
--    the month whose deductions it deposits, the section and the amount; entered on screen or uploaded (TDS_CHALLAN_V1). A challan is
--    never edited: a wrong one is CANCELLED with a reason and entered again. One recorded challan per BSR code, date and serial.
-- 3. payroll_perquisite (CL-085, PERQUISITES_V1) and payroll_past_salary (CL-084 / CL-119, PAST_SALARY_V1): recorded inputs for the
--    income-tax projection, append-only; a later upload of the same key is a new revision that supersedes the earlier one. They are
--    stored and shown only: the TDS projection (statutory/evaluate.ts) has no input hook for them yet, so they change no tax.
-- 4. payroll_gl_mapping and payroll_gl_mapping_line (CL-097): which ledger account each pay head posts to, dated revisions,
--    append-only; the salary journal voucher of an approved or processed run reads the revision in force on the period's last day.
--    The cost centre is the employee's department; nothing is posted without a complete mapping (NOT_CONFIGURED).
-- 5. payroll_edoc_export_file (CL-100): the PDFs of one EDOC export job (a bulk job of kind PAYSLIP_EDOC_EXPORT), one per issued
--    payslip, kept for the requester's download as one ZIP.
--
-- Permissions: payroll_challan.read/manage and payroll_gl_mapping.read/manage are operational configuration; payroll_tax_input.read/
-- import and payroll_output.export (the EDOC archive) are confidential amounts, ceiling-only grants of the HR Administrator (DF02).
-- New companies get the same from modules/payroll-extras/registration.ts.
--
-- To reverse: drop the routes, the six tables, the bulk kind and the permissions added here.

-- 1. Challan master --------------------------------------------------------------------------------------------------------------
create table payroll_challan_setting (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references company (id) on delete restrict,
  statute               text not null check (statute in ('TDS', 'PF', 'ESIC')),
  revision              integer not null check (revision > 0),
  effective_from        date not null,
  tan                   text check (tan ~ '^[A-Z]{4}[0-9]{5}[A-Z]$'),
  establishment_code    text check (establishment_code ~ '^[A-Z0-9/-]{5,30}$'),
  bank_name             text not null check (btrim(bank_name) <> '' and length(bank_name) <= 120),
  bank_branch           text check (bank_branch is null or (btrim(bank_branch) <> '' and length(bank_branch) <= 120)),
  bsr_code              text check (bsr_code ~ '^[0-9]{7}$'),
  reason                text not null check (btrim(reason) <> '' and length(reason) <= 500),
  created_at            timestamptz not null default now(),
  created_by            uuid not null references user_account (id) on delete restrict,
  acting_assignment_id  uuid not null,
  unique (company_id, id),
  unique (company_id, statute, revision),
  foreign key (company_id, acting_assignment_id) references role_assignment (company_id, id) on delete restrict,
  -- The TAN belongs to TDS; an establishment code to PF and ESIC.
  check ((statute = 'TDS') = (tan is not null)),
  check ((statute in ('PF', 'ESIC')) = (establishment_code is not null))
);
create trigger payroll_challan_setting_append_only before update or delete on payroll_challan_setting for each row execute function hrms_append_only();

-- 2. TDS challans -----------------------------------------------------------------------------------------------------------------
create table payroll_tds_challan (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references company (id) on delete restrict,
  -- The first day of the month whose deductions the challan deposits.
  month                 date not null check (extract(day from month) = 1),
  section               text not null check (section ~ '^[0-9A-Z]{1,10}$'),
  bsr_code              text not null check (bsr_code ~ '^[0-9]{7}$'),
  challan_serial        text not null check (challan_serial ~ '^[0-9]{5}$'),
  deposit_date          date not null,
  amount                numeric(19, 2) not null check (amount > 0),
  source                text not null check (source in ('SCREEN', 'IMPORT')),
  import_job_id         uuid,
  state                 text not null default 'RECORDED' check (state in ('RECORDED', 'CANCELLED')),
  cancel_reason         text check (cancel_reason is null or (btrim(cancel_reason) <> '' and length(cancel_reason) <= 500)),
  cancelled_at          timestamptz,
  cancelled_by          uuid references user_account (id) on delete restrict,
  created_at            timestamptz not null default now(),
  created_by            uuid not null references user_account (id) on delete restrict,
  acting_assignment_id  uuid not null,
  version               integer not null default 1 check (version > 0),
  unique (company_id, id),
  foreign key (company_id, acting_assignment_id) references role_assignment (company_id, id) on delete restrict,
  foreign key (company_id, import_job_id) references import_job (company_id, id) on delete restrict,
  -- The batch that recorded an uploaded challan (its preview runs before the batch exists, so the key is set at commit only).
  check (source = 'IMPORT' or import_job_id is null),
  -- Tax of a month is deposited after its deductions start, never before.
  check (deposit_date >= month),
  check ((state = 'CANCELLED') = (cancel_reason is not null and cancelled_at is not null and cancelled_by is not null))
);
create unique index payroll_tds_challan_recorded on payroll_tds_challan (company_id, bsr_code, deposit_date, challan_serial) where (state = 'RECORDED');
create index payroll_tds_challan_month on payroll_tds_challan (company_id, month);

-- A challan's facts never change; it may only be cancelled once, with its reason.
create function hrms_tds_challan_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'a TDS challan is never deleted; cancel it with a reason' using errcode = '23514';
  end if;
  if (new.company_id, new.month, new.section, new.bsr_code, new.challan_serial, new.deposit_date, new.amount, new.source, new.import_job_id, new.created_at,
      new.created_by, new.acting_assignment_id)
     is distinct from
     (old.company_id, old.month, old.section, old.bsr_code, old.challan_serial, old.deposit_date, old.amount, old.source, old.import_job_id, old.created_at,
      old.created_by, old.acting_assignment_id) then
    raise exception 'a TDS challan is never edited; cancel it and enter it again' using errcode = '23514';
  end if;
  if old.state = 'CANCELLED' or new.state <> 'CANCELLED' or new.version <> old.version + 1 then
    raise exception 'a recorded TDS challan can only be cancelled, once' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger payroll_tds_challan_guard before update or delete on payroll_tds_challan for each row execute function hrms_tds_challan_guard();

-- 3. Perquisites and past salary -------------------------------------------------------------------------------------------------
create table payroll_perquisite (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references company (id) on delete restrict,
  employee_id           uuid not null,
  month                 date not null check (extract(day from month) = 1),
  perquisite_type       text not null check (perquisite_type ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  value                 numeric(19, 2) not null check (value >= 0),
  revision              integer not null check (revision > 0),
  -- The committing batch (a preview runs before the batch exists, inside a transaction that is rolled back).
  import_job_id         uuid,
  created_at            timestamptz not null default now(),
  created_by            uuid not null references user_account (id) on delete restrict,
  acting_assignment_id  uuid not null,
  unique (company_id, id),
  unique (company_id, employee_id, month, perquisite_type, revision),
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict,
  foreign key (company_id, import_job_id) references import_job (company_id, id) on delete restrict,
  foreign key (company_id, acting_assignment_id) references role_assignment (company_id, id) on delete restrict
);
create trigger payroll_perquisite_append_only before update or delete on payroll_perquisite for each row execute function hrms_append_only();

create table payroll_past_salary (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references company (id) on delete restrict,
  employee_id           uuid not null,
  fiscal_year           text not null check (fiscal_year ~ '^[0-9]{4}-[0-9]{2}$'),
  -- BEFORE_GO_LIVE: paid by this company before its payroll ran here; PREVIOUS_EMPLOYER: paid by an earlier employer this year.
  source                text not null check (source in ('BEFORE_GO_LIVE', 'PREVIOUS_EMPLOYER')),
  from_month            date not null check (extract(day from from_month) = 1),
  to_month              date not null check (extract(day from to_month) = 1),
  taxable_salary        numeric(19, 2) not null check (taxable_salary >= 0),
  tds_deducted          numeric(19, 2) not null check (tds_deducted >= 0),
  revision              integer not null check (revision > 0),
  import_job_id         uuid,
  created_at            timestamptz not null default now(),
  created_by            uuid not null references user_account (id) on delete restrict,
  acting_assignment_id  uuid not null,
  unique (company_id, id),
  unique (company_id, employee_id, fiscal_year, source, revision),
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict,
  foreign key (company_id, import_job_id) references import_job (company_id, id) on delete restrict,
  foreign key (company_id, acting_assignment_id) references role_assignment (company_id, id) on delete restrict,
  check (from_month <= to_month)
);
create trigger payroll_past_salary_append_only before update or delete on payroll_past_salary for each row execute function hrms_append_only();

-- 4. GL mapping ------------------------------------------------------------------------------------------------------------------
create table payroll_gl_mapping (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references company (id) on delete restrict,
  revision              integer not null check (revision > 0),
  effective_from        date not null,
  net_pay_account_code  text not null check (net_pay_account_code ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$'),
  net_pay_account_name  text check (net_pay_account_name is null or (btrim(net_pay_account_name) <> '' and length(net_pay_account_name) <= 120)),
  reason                text not null check (btrim(reason) <> '' and length(reason) <= 500),
  created_at            timestamptz not null default now(),
  created_by            uuid not null references user_account (id) on delete restrict,
  acting_assignment_id  uuid not null,
  unique (company_id, id),
  unique (company_id, revision),
  foreign key (company_id, acting_assignment_id) references role_assignment (company_id, id) on delete restrict
);
create trigger payroll_gl_mapping_append_only before update or delete on payroll_gl_mapping for each row execute function hrms_append_only();

create table payroll_gl_mapping_line (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references company (id) on delete restrict,
  mapping_id            uuid not null,
  component_id          uuid not null,
  -- Earnings, reimbursements and employer contributions are debited here; deductions are credited here.
  account_code          text not null check (account_code ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$'),
  account_name          text check (account_name is null or (btrim(account_name) <> '' and length(account_name) <= 120)),
  -- An employer contribution's liability (credited); unused by the other head types.
  payable_account_code  text check (payable_account_code ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$'),
  payable_account_name  text check (payable_account_name is null or (btrim(payable_account_name) <> '' and length(payable_account_name) <= 120)),
  unique (company_id, id),
  unique (company_id, mapping_id, component_id),
  foreign key (company_id, mapping_id) references payroll_gl_mapping (company_id, id) on delete restrict,
  foreign key (company_id, component_id) references pay_component (company_id, id) on delete restrict
);
create trigger payroll_gl_mapping_line_append_only before update or delete on payroll_gl_mapping_line for each row execute function hrms_append_only();

-- 5. EDOC export ------------------------------------------------------------------------------------------------------------------
alter table bulk_job drop constraint bulk_job_kind_check;
alter table bulk_job add constraint bulk_job_kind_check check (kind in ('ATTENDANCE_PROCESSING', 'LEAVE_ACCRUAL', 'INCREMENT_REVIEW_OPENING', 'LEAVE_YEAR_END', 'PAYSLIP_EDOC_EXPORT'));

create table payroll_edoc_export_file (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references company (id) on delete restrict,
  job_id                uuid not null,
  output_id             uuid not null,
  employee_id           uuid not null,
  file_name             text not null check (file_name ~ '^[A-Za-z0-9._-]{1,200}$'),
  content               bytea not null,
  content_sha256        text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  -- The hash of the issued payslip document the PDF was rendered for (employee_issued_output.content_hash).
  issued_content_hash   text not null,
  created_at            timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, job_id, output_id),
  foreign key (company_id, job_id) references bulk_job (company_id, id) on delete restrict,
  foreign key (company_id, output_id, employee_id) references employee_issued_output (company_id, id, employee_id) on delete restrict
);

-- Permissions ----------------------------------------------------------------------------------------------------------------------
insert into permission (resource, action, field_group) values
  ('payroll_challan', 'read', 'operational'),
  ('payroll_challan', 'manage', 'operational'),
  ('payroll_gl_mapping', 'read', 'operational'),
  ('payroll_gl_mapping', 'manage', 'operational'),
  ('payroll_tax_input', 'read', 'amount'),
  ('payroll_tax_input', 'import', 'amount'),
  ('payroll_output', 'export', 'amount')
on conflict do nothing;

-- Role ceilings, as modules/payroll-extras/registration.ts gives a new company (default duties are taken by new assignments; existing
-- approved assignments keep their frozen allowlists, 0099).
insert into role_permission (company_id, role_id, permission_id, effect)
select r.company_id, r.id, p.id, 'ALLOW'
  from role r
  join (values
    ('HR_ADMINISTRATOR', 'payroll_challan', 'read', 'operational'),
    ('HR_ADMINISTRATOR', 'payroll_challan', 'manage', 'operational'),
    ('HR_ADMINISTRATOR', 'payroll_gl_mapping', 'read', 'operational'),
    ('HR_ADMINISTRATOR', 'payroll_gl_mapping', 'manage', 'operational'),
    ('HR_ADMINISTRATOR', 'payroll_tax_input', 'read', 'amount'),
    ('HR_ADMINISTRATOR', 'payroll_tax_input', 'import', 'amount'),
    ('HR_ADMINISTRATOR', 'payroll_output', 'export', 'amount'),
    ('PAYROLL_OPERATOR', 'payroll_challan', 'read', 'operational'),
    ('PAYROLL_OPERATOR', 'payroll_challan', 'manage', 'operational'),
    ('PAYROLL_OPERATOR', 'payroll_gl_mapping', 'read', 'operational'),
    ('PAYROLL_OPERATOR', 'payroll_gl_mapping', 'manage', 'operational'),
    ('PAYROLL_APPROVER', 'payroll_challan', 'read', 'operational'),
    ('PAYROLL_APPROVER', 'payroll_gl_mapping', 'read', 'operational'),
    ('FINANCE_REVIEWER', 'payroll_challan', 'read', 'operational'),
    ('FINANCE_REVIEWER', 'payroll_gl_mapping', 'read', 'operational')
  ) g (role_code, resource, action, field_group) on g.role_code = r.code
  join permission p on p.resource = g.resource and p.action = g.action and p.field_group = g.field_group
on conflict (company_id, role_id, permission_id) do nothing;

-- The operational groups, classified as every company's employee operational group is (as 0201 does for attachment).
insert into confidential_field_policy (company_id, resource_code, field_group, classification, effective_from, approved_by, approved_at, created_by)
select cfp.company_id, g.resource, 'operational', 'OPERATIONAL', cfp.effective_from, cfp.approved_by, now(), cfp.approved_by
  from confidential_field_policy cfp
 cross join (values ('payroll_challan'), ('payroll_gl_mapping')) g (resource)
 where cfp.resource_code = 'employee' and cfp.field_group = 'operational' and cfp.effective_to is null
   and not exists (select 1 from confidential_field_policy x where x.company_id = cfp.company_id and x.resource_code = g.resource and x.field_group = 'operational');
