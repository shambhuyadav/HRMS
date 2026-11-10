-- 0262 Appraisal rating bands and target distribution for the bell curve (BRD coverage CL-132 "Performance management -> Bell
-- Curve", under FR-040 to FR-044; FR-044 "Respect configured employee visibility of ratings, HR oversight, appraisal report and bell
-- curve ... Proposed distribution charts must report selected population and period"; acceptance "score counts reconcile to the
-- selected population"; BR-044; DF02). Built 10 Nov 2026 from the reference screen's structure (company, cycle year, department,
-- grade; show data / show bell curve); decided under owner delegation, 6 Nov 2026.
--
-- F1 selects "no forced distribution or bell-curve target" (docs/03 I-24). That is kept: a target here is a reference HR may set to
-- compare a cycle's final ratings against. It never constrains, changes, normalises or blocks any rating; nothing is seeded, so no
-- company has a target until HR records one; and the bell curve is read-only. The owner is asked to confirm (I-24 amendment).
--
-- appraisal_rating_band_setting: a revision of the bands and targets, for one cycle or (cycle_id NULL) the company's default. The
-- revision in force is the highest of the cycle's own, else the highest of the company default. Revisions are append-only.
-- appraisal_rating_band: one band of a revision: a range of final ratings (F1 scale 1.00 to 5.00, two decimals as stored on the
-- appraisal) and its target share. At commit a revision's bands must cover 1.00 to 5.00 in sequence order with no gap or overlap,
-- so every final rating falls in exactly one band and the band counts reconcile to the completed population, and the targets must
-- add up to exactly 100.
--
-- Permission: appraisal_distribution.manage.operational, a default duty of the HR Administrator (bands and target shares are policy
-- configuration, not anyone's rating). Reading the bell curve itself needs appraisal.report.rating (the confidential rating group).
--
-- To reverse: drop the route, then the two tables, their triggers and the permission added here.

create table appraisal_rating_band_setting (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references company (id) on delete restrict,
  -- NULL: the company default, used by every cycle without its own.
  cycle_id             uuid,
  revision             integer not null check (revision > 0),
  reason               text not null check (btrim(reason) <> '' and length(reason) <= 1000),
  created_at           timestamptz not null default now(),
  created_by           uuid not null references user_account (id) on delete restrict,
  acting_assignment_id uuid not null,
  unique (company_id, id),
  foreign key (company_id, cycle_id) references appraisal_cycle (company_id, id) on delete restrict,
  foreign key (company_id, acting_assignment_id) references role_assignment (company_id, id) on delete restrict
);
create unique index appraisal_rating_band_setting_revision
  on appraisal_rating_band_setting (company_id, coalesce(cycle_id, '00000000-0000-0000-0000-000000000000'::uuid), revision);
create trigger appraisal_rating_band_setting_append_only before update or delete on appraisal_rating_band_setting for each row execute function hrms_append_only();

create table appraisal_rating_band (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references company (id) on delete restrict,
  setting_id      uuid not null,
  sequence        integer not null check (sequence between 1 and 20),
  code            text not null check (code ~ '^[A-Z][A-Z0-9_]{0,19}$'),
  label           text not null check (btrim(label) <> '' and length(label) <= 100),
  min_rating      numeric(5, 2) not null check (min_rating between 1 and 5),
  max_rating      numeric(5, 2) not null check (max_rating between 1 and 5),
  target_percent  numeric(5, 2) not null check (target_percent between 0 and 100),
  unique (company_id, id),
  unique (company_id, setting_id, sequence),
  unique (company_id, setting_id, code),
  foreign key (company_id, setting_id) references appraisal_rating_band_setting (company_id, id) on delete restrict,
  check (max_rating >= min_rating)
);
create trigger appraisal_rating_band_append_only before update or delete on appraisal_rating_band for each row execute function hrms_append_only();

-- At commit: the revision's bands cover 1.00 to 5.00 in sequence order without gap or overlap, and their targets add up to 100.
create function hrms_appraisal_rating_bands_complete() returns trigger language plpgsql as $$
declare
  sid uuid;
  bands integer;
  total numeric;
  broken integer;
begin
  -- Separate statements: each is planned only when it runs, against the row type of the table that fired.
  if tg_table_name = 'appraisal_rating_band' then
    sid := new.setting_id;
  else
    sid := new.id;
  end if;
  select count(*), coalesce(sum(target_percent), 0) into bands, total
    from appraisal_rating_band where company_id = new.company_id and setting_id = sid;
  if bands = 0 then
    raise exception 'a rating distribution needs at least one band' using errcode = '23514';
  end if;
  if total <> 100 then
    raise exception 'the target percentages of a rating distribution must add up to 100 (they add up to %)', total using errcode = '23514';
  end if;
  select count(*) into broken
    from (select min_rating, max_rating,
                 lag(max_rating) over (order by sequence) as previous_max,
                 row_number() over (order by sequence) as position,
                 count(*) over () as bands
            from appraisal_rating_band where company_id = new.company_id and setting_id = sid) b
   where (b.position = 1 and b.min_rating <> 1.00)
      or (b.position > 1 and b.min_rating <> b.previous_max + 0.01)
      or (b.position = b.bands and b.max_rating <> 5.00);
  if broken > 0 then
    raise exception 'the bands of a rating distribution must cover the ratings 1.00 to 5.00 in order, without gap or overlap' using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger appraisal_rating_band_setting_complete after insert on appraisal_rating_band_setting
  deferrable initially deferred for each row execute function hrms_appraisal_rating_bands_complete();
create constraint trigger appraisal_rating_band_complete after insert on appraisal_rating_band
  deferrable initially deferred for each row execute function hrms_appraisal_rating_bands_complete();

insert into permission (resource, action, field_group) values ('appraisal_distribution', 'manage', 'operational') on conflict do nothing;

-- Ceiling of every company's HR Administrator role (new companies get it from modules/appraisal/registration.ts). New HR
-- Administrator assignments take it as a default duty; existing approved assignments keep their frozen allowlists (0099).
insert into role_permission (company_id, role_id, permission_id, effect)
select r.company_id, r.id, p.id, 'ALLOW'
  from role r
  join permission p on p.resource = 'appraisal_distribution' and p.action = 'manage' and p.field_group = 'operational'
 where r.code = 'HR_ADMINISTRATOR'
on conflict (company_id, role_id, permission_id) do nothing;
