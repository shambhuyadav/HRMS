-- 0300 Statutory filing files, batch R4 (BRD coverage CL-093 TDS quarterly summary, CL-105 PF new joiners, CL-106 EPFO ECR, CL-107
-- ESIC monthly and half-yearly; FR-036, FR-039, FR-107, FR-108; built 11 Nov 2026, decided under owner delegation, 6 Nov 2026). The
-- module is modules/statutory-files. Nothing here activates anything: every statutory rule pack stays as it is (inactive until the
-- owner's CA authorises it) and no company has an accepted format, so every file answers NOT_CONFIGURED until both exist.
--
-- 1. statutory_file_format: a company's statement that one output (PF_ECR, ESIC_MONTHLY, ...) is produced in a named format (the
--    format reference, for example "ECR 2.0") from a date. The layout itself is the build's (modules/statutory-files/outputs.ts); the
--    row fixes the hash of the synthetic sample the build rendered when the format was set up, so an acceptance binds to that exact
--    layout, and a build that renders differently reads NOT_CONFIGURED until a new revision is set up and accepted. Append-only: a
--    change is a new revision.
-- 2. statutory_file_format_decision: the acceptance of a format revision (its sample validated, with a reference, by someone other
--    than the person who set it up) or its withdrawal (with a reason). At most one of each per revision, nothing after a withdrawal;
--    append-only. The database itself refuses an acceptance by the format's author or of another sample.
-- The format in force for an output on a day is the accepted, not withdrawn revision with the latest start on or before it (the
-- highest revision among those of one date).
--
-- Permissions: payroll_statutory_format.define (set a format up) and payroll_statutory_format.accept (validate its sample and accept
-- it, or withdraw it), the maker-checker pair, both operational and ceiling-only. Reading formats and samples is the existing
-- payroll_statutory.read.operational. The files use the existing confidential report grants (payroll_report.read.amount for the
-- status, payroll_report.export.amount for the download) and, where a file carries UAN or IP numbers, employee.read.payroll_id.
-- New companies get the same from modules/statutory-files/registration.ts.
--
-- To reverse: drop the routes, the two tables and their function, and the permissions, role ceilings and classification rows added
-- here (the classification is dated: end it rather than delete it).

create table statutory_file_format (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references company (id) on delete restrict,
  output_code           text not null check (output_code in ('PF_ECR', 'PF_NEW_JOINERS', 'ESIC_MONTHLY', 'ESIC_HALF_YEARLY', 'TDS_QUARTERLY', 'PT_STATE_RETURN', 'LWF_STATE_RETURN')),
  revision              integer not null check (revision > 0),
  -- The published specification the company's filer works to, as they name it ("ECR 2.0", "ESIC monthly contribution upload").
  format_reference      text not null check (btrim(format_reference) <> '' and length(format_reference) <= 200),
  effective_from        date not null,
  layout_version        integer not null check (layout_version > 0),
  sample_hash           text not null check (sample_hash ~ '^[0-9a-f]{64}$'),
  note                  text check (note is null or (btrim(note) <> '' and length(note) <= 500)),
  created_at            timestamptz not null default now(),
  created_by            uuid not null references user_account (id) on delete restrict,
  acting_assignment_id  uuid not null,
  unique (company_id, id),
  unique (company_id, output_code, revision),
  foreign key (company_id, acting_assignment_id) references role_assignment (company_id, id) on delete restrict
);
create trigger statutory_file_format_append_only before update or delete on statutory_file_format for each row execute function hrms_append_only();

create table statutory_file_format_decision (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references company (id) on delete restrict,
  format_id             uuid not null,
  decision              text not null check (decision in ('ACCEPTED', 'WITHDRAWN')),
  -- ACCEPTED: the hash of the sample the checker validated (it must be the format's own).
  sample_hash           text check (sample_hash ~ '^[0-9a-f]{64}$'),
  -- ACCEPTED: the validation reference (for example the portal validator's run or the CA's note); WITHDRAWN: the reason.
  reference             text not null check (btrim(reference) <> '' and length(reference) <= 500),
  decided_at            timestamptz not null default now(),
  decided_by            uuid not null references user_account (id) on delete restrict,
  acting_assignment_id  uuid not null,
  unique (company_id, id),
  unique (company_id, format_id, decision),
  foreign key (company_id, format_id) references statutory_file_format (company_id, id) on delete restrict,
  foreign key (company_id, acting_assignment_id) references role_assignment (company_id, id) on delete restrict,
  check ((decision = 'ACCEPTED') = (sample_hash is not null))
);

-- Maker-checker in the database: the author never accepts their own format, an acceptance validates the format's own sample, and a
-- withdrawn format takes no further decision.
create function hrms_statutory_file_format_decision_guard() returns trigger language plpgsql as $$
declare
  f statutory_file_format%rowtype;
begin
  select * into f from statutory_file_format where company_id = new.company_id and id = new.format_id;
  if exists (select 1 from statutory_file_format_decision d where d.company_id = new.company_id and d.format_id = new.format_id and d.decision = 'WITHDRAWN') then
    raise exception 'a withdrawn statutory file format takes no further decision' using errcode = '23514';
  end if;
  if new.decision = 'ACCEPTED' then
    if new.decided_by = f.created_by then
      raise exception 'the author of a statutory file format does not accept it' using errcode = '23514';
    end if;
    if new.sample_hash is distinct from f.sample_hash then
      raise exception 'an acceptance validates the sample the format was set up with' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger statutory_file_format_decision_guard before insert on statutory_file_format_decision for each row execute function hrms_statutory_file_format_decision_guard();
create trigger statutory_file_format_decision_append_only before update or delete on statutory_file_format_decision for each row execute function hrms_append_only();

-- Permissions ----------------------------------------------------------------------------------------------------------------------
insert into permission (resource, action, field_group) values
  ('payroll_statutory_format', 'define', 'operational'),
  ('payroll_statutory_format', 'accept', 'operational')
on conflict do nothing;

-- Role ceilings, as modules/statutory-files/registration.ts gives a new company: the HR Administrator may hold either side, the Payroll
-- Operator sets formats up and the Payroll Approver accepts them. No default duty: each is granted per assignment.
insert into role_permission (company_id, role_id, permission_id, effect)
select r.company_id, r.id, p.id, 'ALLOW'
  from role r
  join (values
    ('HR_ADMINISTRATOR', 'payroll_statutory_format', 'define', 'operational'),
    ('HR_ADMINISTRATOR', 'payroll_statutory_format', 'accept', 'operational'),
    ('PAYROLL_OPERATOR', 'payroll_statutory_format', 'define', 'operational'),
    ('PAYROLL_APPROVER', 'payroll_statutory_format', 'accept', 'operational')
  ) g (role_code, resource, action, field_group) on g.role_code = r.code
  join permission p on p.resource = g.resource and p.action = g.action and p.field_group = g.field_group
on conflict (company_id, role_id, permission_id) do nothing;

-- The operational group, classified for every existing company as its employee operational group is (as 0270 and 0291 do): without a
-- row it would read as CONFIDENTIAL there. It holds format references, dates and sample hashes, nothing about an employee.
insert into confidential_field_policy (company_id, resource_code, field_group, classification, effective_from, approved_by, approved_at, created_by)
select cfp.company_id, 'payroll_statutory_format', 'operational', 'OPERATIONAL', cfp.effective_from, cfp.approved_by, now(), cfp.approved_by
  from confidential_field_policy cfp
 where cfp.resource_code = 'employee' and cfp.field_group = 'operational' and cfp.effective_to is null
   and not exists (select 1 from confidential_field_policy x where x.company_id = cfp.company_id and x.resource_code = 'payroll_statutory_format' and x.field_group = 'operational');
