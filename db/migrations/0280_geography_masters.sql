-- 0280 State, city, qualification and bank masters (BRD coverage CL-005 "State Master", CL-006 "City Master", CL-007 "Qualification
-- Master", CL-010 "Bank Master", under FR-004 configurable entities; DF04 controlled lists; DB006; BR-004). Built 11 Nov 2026 from the
-- reference system's screens (the BRD names each only as a menu label); decided under owner delegation, 6 Nov 2026.
--
-- Three of the four are flat lists, so they are reference values a company keeps on the existing Reference values screen
-- (reference/maintenance.ts): created, relabelled, deactivated or end-dated, audited, never deleted.
--   STATE_IN       the states and union territories of India, one list per country (STATE_<ISO 3166 alpha-2>), India first. Codes
--                  are the ISO 3166-2:IN subdivision codes (as revised in 2023: CG, OD, TS, UK), the same two letters the professional
--                  tax state of a work location already uses (location_pt_state, 0220: MH, KA). Labels are the names in common use.
--   QUALIFICATION  qualification names (B.Tech, MBA, ...) offered as suggestions where the employee record's qualification section
--                  takes a qualification (0191 keeps that value as text, so no existing entry changes meaning).
--   BANK           bank names a company pays through; seeded empty, each company adds its own.
-- New companies get the same values from their module registrations (org/masters-registration.ts, employee/record-registration.ts).
--
-- A city has a parent state, so it is a master of its own: city, keyed by its state (a reference value of a STATE_<country> list,
-- pinned by the composite key as every reference does, CI15) and a code unique within that state. Like the organisation masters
-- (0102) it has a name, an active flag and a validity period [valid_from, valid_to); it is deactivated or closed, never deleted.
-- It is read and changed under the organisation master permissions (org_master.read / create / update, operational), so no new
-- permission is added. Nothing refers to a city yet.
--
-- To reverse: drop the city table, then deactivate (never delete) the seeded STATE_IN and QUALIFICATION values.

create table city (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references company (id) on delete restrict,
  state_category  text not null check (state_category ~ '^STATE_[A-Z]{2}$'),
  state_id        uuid not null,
  code            text not null check (code ~ '^[A-Z0-9][A-Z0-9_-]{0,39}$'),
  name            text not null check (name = btrim(name) and name <> '' and length(name) <= 200),
  active          boolean not null,
  valid_from      date,
  valid_to        date,
  created_at      timestamptz not null default now(),
  created_by      uuid references user_account (id) on delete restrict,
  updated_at      timestamptz not null default now(),
  updated_by      uuid references user_account (id) on delete restrict,
  version         integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, state_id, code),
  foreign key (company_id, state_category, state_id) references reference_value (company_id, category, id) on delete restrict,
  constraint city_valid_period_check check (valid_to > valid_from)
);
create index city_state_idx on city (company_id, state_id, code);

-- A city keeps its state and code: a different state or code is a different city.
create function hrms_city_guard() returns trigger language plpgsql as $$
begin
  if (new.state_category, new.state_id, new.code) is distinct from (old.state_category, old.state_id, old.code) then
    raise exception 'a city keeps its state and code' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger city_guard before update on city for each row execute function hrms_city_guard();
create trigger city_touch before update on city for each row execute function hrms_touch();
create trigger city_no_delete before delete on city for each row execute function hrms_no_delete();

-- The states and union territories of India, for every company (provisioning seeds them for a new one).
insert into reference_value (company_id, category, code, label, active, created_by)
select c.id, 'STATE_IN', v.code, v.label, true, '00000000-0000-4000-8000-000000000001'
  from company c
 cross join (values
   ('AN', 'Andaman and Nicobar Islands'),
   ('AP', 'Andhra Pradesh'),
   ('AR', 'Arunachal Pradesh'),
   ('AS', 'Assam'),
   ('BR', 'Bihar'),
   ('CH', 'Chandigarh'),
   ('CG', 'Chhattisgarh'),
   ('DH', 'Dadra and Nagar Haveli and Daman and Diu'),
   ('DL', 'Delhi'),
   ('GA', 'Goa'),
   ('GJ', 'Gujarat'),
   ('HR', 'Haryana'),
   ('HP', 'Himachal Pradesh'),
   ('JK', 'Jammu and Kashmir'),
   ('JH', 'Jharkhand'),
   ('KA', 'Karnataka'),
   ('KL', 'Kerala'),
   ('LA', 'Ladakh'),
   ('LD', 'Lakshadweep'),
   ('MP', 'Madhya Pradesh'),
   ('MH', 'Maharashtra'),
   ('MN', 'Manipur'),
   ('ML', 'Meghalaya'),
   ('MZ', 'Mizoram'),
   ('NL', 'Nagaland'),
   ('OD', 'Odisha'),
   ('PY', 'Puducherry'),
   ('PB', 'Punjab'),
   ('RJ', 'Rajasthan'),
   ('SK', 'Sikkim'),
   ('TN', 'Tamil Nadu'),
   ('TS', 'Telangana'),
   ('TR', 'Tripura'),
   ('UP', 'Uttar Pradesh'),
   ('UK', 'Uttarakhand'),
   ('WB', 'West Bengal')) v (code, label)
on conflict (company_id, category, code) do nothing;

-- Common qualification names, offered as suggestions (provisioning seeds them for a new company).
insert into reference_value (company_id, category, code, label, active, created_by)
select c.id, 'QUALIFICATION', v.code, v.label, true, '00000000-0000-4000-8000-000000000001'
  from company c
 cross join (values
   ('ITI', 'ITI certificate'),
   ('DIPLOMA_ENGINEERING', 'Diploma in Engineering'),
   ('BA', 'B.A.'),
   ('BCOM', 'B.Com'),
   ('BSC', 'B.Sc'),
   ('BBA', 'BBA'),
   ('BCA', 'BCA'),
   ('BE', 'B.E.'),
   ('BTECH', 'B.Tech'),
   ('BED', 'B.Ed'),
   ('LLB', 'LL.B'),
   ('MBBS', 'MBBS'),
   ('MA', 'M.A.'),
   ('MCOM', 'M.Com'),
   ('MSC', 'M.Sc'),
   ('MBA', 'MBA'),
   ('MCA', 'MCA'),
   ('ME', 'M.E.'),
   ('MTECH', 'M.Tech'),
   ('PHD', 'Ph.D'),
   ('CA', 'Chartered Accountant (CA)'),
   ('CS', 'Company Secretary (CS)'),
   ('CMA', 'Cost and Management Accountant (CMA)')) v (code, label)
on conflict (company_id, category, code) do nothing;
