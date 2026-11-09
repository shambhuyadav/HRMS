-- 0230 Appraisal competency masters and the dated scoring split (FR-041 "grade-mapped competencies"; FR-042; BR-014; OQ-10;
-- E11 "Grade competency mapping"; CL-123 "Competency Config"; I-86, decided under owner delegation, 6 Nov 2026). Synthetic data only.
--
-- 1. appraisal_scoring_setting: the company's dated split of the overall weighted result between goals and competencies, whole
--    percentages adding to 100 (goals 1..100, competencies 0..99). One revision per period, changed by HR (Appraisal Config:
--    appraisal_cycle.manage), never in place: a revision's values never change and it only gets its end date when the next one
--    starts. A new cycle takes the split in force on its start date and keeps its own copy (0231). Each company starts with one
--    revision from 2000-01-01 holding the delegated default 70 / 30, written by the system actor; provisioning gives a new company
--    the same (modules/appraisal/scoring-default.ts).
-- 2. appraisal_competency: the company competency master maintained by HR. A permanent code, a name, a description, one
--    behavioural indicator for each proficiency level 1..5 (the F1 scale: position n describes level n), and active dates
--    [active_from, active_to). A competency's start is fixed once a set uses it, and it is ended only after every set using it.
-- 3. appraisal_competency_set: the dated mapping of competencies to a grade, optionally narrowed to one designation (the more
--    specific set applies). Sets of one grade (and designation) never overlap; a set is fixed once written and only gets its end
--    date. Its items carry whole-number weights 1..100 totalling exactly 100 (checked at commit), as goals do, so the competency
--    result sum(weight x score) / 100 is exact at two decimals. Each item's competency is active when the set starts, and an open
--    set holds no competency that has an end date.
-- Masters are operational configuration (names, indicators and weights are not about a person). Scores never live here.

-- ---------------------------------------------------------------------------------------------------------------
-- Dated scoring split
-- ---------------------------------------------------------------------------------------------------------------
create table appraisal_scoring_setting (
  id                         uuid primary key default gen_random_uuid(),
  company_id                 uuid not null references company (id) on delete restrict,
  effective_from             date not null,
  effective_to               date check (effective_to > effective_from),
  goal_weight_percent        smallint not null check (goal_weight_percent between 1 and 100),
  competency_weight_percent  smallint not null check (competency_weight_percent between 0 and 99),
  reason                     text not null check (btrim(reason) <> '' and length(reason) <= 1000),
  created_at                 timestamptz not null default now(),
  created_by                 uuid not null references user_account (id) on delete restrict,
  updated_at                 timestamptz not null default now(),
  updated_by                 uuid references user_account (id) on delete restrict,
  version                    integer not null default 1 check (version > 0),
  unique (company_id, id),
  check (goal_weight_percent + competency_weight_percent = 100),
  exclude using gist (company_id with =, daterange(effective_from, effective_to, '[)') with &&)
);

create function hrms_appraisal_scoring_setting_frozen() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'appraisal scoring settings are kept; close a revision by starting the next one' using errcode = '23514';
  end if;
  if (new.company_id, new.effective_from, new.goal_weight_percent, new.competency_weight_percent, new.reason, new.created_by, new.created_at)
     is distinct from (old.company_id, old.effective_from, old.goal_weight_percent, old.competency_weight_percent, old.reason, old.created_by, old.created_at)
     or (old.effective_to is not null and new.effective_to is distinct from old.effective_to) then
    raise exception 'an appraisal scoring revision is fixed; only an open revision may be given its end date' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger appraisal_scoring_setting_frozen before update or delete on appraisal_scoring_setting
  for each row execute function hrms_appraisal_scoring_setting_frozen();
create trigger appraisal_scoring_setting_touch before update on appraisal_scoring_setting for each row execute function hrms_touch();

insert into appraisal_scoring_setting (company_id, effective_from, goal_weight_percent, competency_weight_percent, reason, created_by)
select c.id, '2000-01-01', 70, 30, 'Initial split decided under owner delegation, 6 Nov 2026 (I-86)', '00000000-0000-4000-8000-000000000001'
  from company c
 where not exists (select 1 from appraisal_scoring_setting s where s.company_id = c.id);

-- ---------------------------------------------------------------------------------------------------------------
-- Competency master
-- ---------------------------------------------------------------------------------------------------------------
-- Five non-blank behavioural indicators of at most 1000 characters, one per proficiency level 1..5.
create function hrms_appraisal_indicators_valid(indicators text[]) returns boolean language sql immutable as $$
  -- coalesce: an empty array has no dimensions (NULL), and a CHECK that yields NULL would pass.
  select coalesce(array_ndims(indicators) = 1 and array_lower(indicators, 1) = 1 and array_length(indicators, 1) = 5
     and not exists (select 1 from unnest(indicators) as u (v) where u.v is null or btrim(u.v) = '' or length(u.v) > 1000), false)
$$;

create table appraisal_competency (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references company (id) on delete restrict,
  code         text not null check (code ~ '^[A-Z0-9][A-Z0-9_-]{0,39}$'),
  name         text not null check (btrim(name) <> '' and length(name) <= 200),
  description  text check (description is null or (btrim(description) <> '' and length(description) <= 2000)),
  indicators   text[] not null check (hrms_appraisal_indicators_valid(indicators)),
  active_from  date not null,
  active_to    date check (active_to > active_from),
  created_at   timestamptz not null default now(),
  created_by   uuid not null references user_account (id) on delete restrict,
  updated_at   timestamptz not null default now(),
  updated_by   uuid references user_account (id) on delete restrict,
  version      integer not null default 1 check (version > 0),
  unique (company_id, code),
  unique (company_id, id)
);

-- ---------------------------------------------------------------------------------------------------------------
-- Dated grade (and designation) mapping
-- ---------------------------------------------------------------------------------------------------------------
create table appraisal_competency_set (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references company (id) on delete restrict,
  grade_id        uuid not null,
  -- Null: every designation of the grade without a set of its own.
  designation_id  uuid,
  effective_from  date not null,
  effective_to    date check (effective_to > effective_from),
  reason          text not null check (btrim(reason) <> '' and length(reason) <= 1000),
  created_at      timestamptz not null default now(),
  created_by      uuid not null references user_account (id) on delete restrict,
  updated_at      timestamptz not null default now(),
  updated_by      uuid references user_account (id) on delete restrict,
  version         integer not null default 1 check (version > 0),
  unique (company_id, id),
  foreign key (company_id, grade_id) references grade (company_id, id) on delete restrict,
  foreign key (company_id, designation_id) references designation (company_id, id) on delete restrict,
  exclude using gist (company_id with =, grade_id with =, (coalesce(designation_id, '00000000-0000-0000-0000-000000000000'::uuid)) with =,
                      daterange(effective_from, effective_to, '[)') with &&)
);
create index appraisal_competency_set_lookup_idx on appraisal_competency_set (company_id, grade_id, designation_id, effective_from);

create table appraisal_competency_set_item (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references company (id) on delete restrict,
  set_id         uuid not null,
  competency_id  uuid not null,
  sequence       integer not null check (sequence between 1 and 50),
  weight         integer not null check (weight between 1 and 100),
  created_at     timestamptz not null default now(),
  created_by     uuid not null references user_account (id) on delete restrict,
  unique (company_id, id),
  unique (company_id, set_id, competency_id),
  unique (company_id, set_id, sequence),
  foreign key (company_id, set_id) references appraisal_competency_set (company_id, id) on delete restrict,
  foreign key (company_id, competency_id) references appraisal_competency (company_id, id) on delete restrict
);
create index appraisal_competency_set_item_competency_idx on appraisal_competency_set_item (company_id, competency_id);

-- A set is fixed once written: only an open set may be given its end date, once.
create function hrms_appraisal_competency_set_frozen() returns trigger language plpgsql as $$
begin
  if (new.grade_id, new.designation_id, new.effective_from, new.reason) is distinct from (old.grade_id, old.designation_id, old.effective_from, old.reason)
     or (old.effective_to is not null and new.effective_to is distinct from old.effective_to) then
    raise exception 'a competency set is fixed; only an open set may be given its end date' using errcode = '23514';
  end if;
  -- An open set holds no competency that has an end date; a closed one ends no later than each of its competencies.
  if exists (select 1 from appraisal_competency_set_item si join appraisal_competency k on k.company_id = si.company_id and k.id = si.competency_id
              where si.company_id = new.company_id and si.set_id = new.id and k.active_to is not null
                and (new.effective_to is null or new.effective_to > k.active_to)) then
    raise exception 'a competency set ends no later than each of its competencies' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger appraisal_competency_set_frozen before update on appraisal_competency_set for each row execute function hrms_appraisal_competency_set_frozen();

-- Items are written with their set (in the set's own transaction), for a competency active when the set starts and not ended
-- while the set is in force; items never change.
create function hrms_appraisal_competency_set_item_guard() returns trigger language plpgsql as $$
declare
  s record;
  k record;
begin
  select created_at, effective_from, effective_to into s from appraisal_competency_set where company_id = new.company_id and id = new.set_id;
  if s.created_at is distinct from now() then
    raise exception 'competency set items are written with their set, then fixed' using errcode = '23514';
  end if;
  select active_from, active_to into k from appraisal_competency where company_id = new.company_id and id = new.competency_id;
  if k.active_from > s.effective_from or (k.active_to is not null and (s.effective_to is null or s.effective_to > k.active_to)) then
    raise exception 'a competency set holds only competencies active for the whole time it is in force' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger appraisal_competency_set_item_guard before insert on appraisal_competency_set_item for each row execute function hrms_appraisal_competency_set_item_guard();
create trigger appraisal_competency_set_item_append_only before update or delete on appraisal_competency_set_item for each row execute function hrms_append_only();

-- At commit a set has at least one item and its weights total exactly 100 (F1 rule for goals, applied to competencies).
create function hrms_appraisal_competency_set_total() returns trigger language plpgsql as $$
declare
  target uuid;
  total integer;
begin
  -- Separate statements: a set row has no set_id field, and only the branch that runs is prepared.
  if tg_table_name = 'appraisal_competency_set' then
    target := new.id;
  else
    target := new.set_id;
  end if;
  select coalesce(sum(weight), 0) into total from appraisal_competency_set_item where company_id = new.company_id and set_id = target;
  if total <> 100 then
    raise exception 'the weights of a competency set total exactly 100 (now %)', total using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger appraisal_competency_set_total after insert on appraisal_competency_set
  deferrable initially deferred for each row execute function hrms_appraisal_competency_set_total();
create constraint trigger appraisal_competency_set_item_total after insert on appraisal_competency_set_item
  deferrable initially deferred for each row execute function hrms_appraisal_competency_set_total();

-- A competency keeps its code; its start is fixed once a set uses it; it ends only after every set using it.
create function hrms_appraisal_competency_guard() returns trigger language plpgsql as $$
begin
  if new.code is distinct from old.code then
    raise exception 'a competency code is permanent' using errcode = '23514';
  end if;
  if new.active_from is distinct from old.active_from and exists (
       select 1 from appraisal_competency_set_item si where si.company_id = new.company_id and si.competency_id = new.id) then
    raise exception 'the start of a competency in use is fixed' using errcode = '23514';
  end if;
  if new.active_to is not null and new.active_to is distinct from old.active_to and exists (
       select 1 from appraisal_competency_set_item si join appraisal_competency_set s on s.company_id = si.company_id and s.id = si.set_id
        where si.company_id = new.company_id and si.competency_id = new.id and (s.effective_to is null or s.effective_to > new.active_to)) then
    raise exception 'a competency ends only after every set using it' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger appraisal_competency_guard before update on appraisal_competency for each row execute function hrms_appraisal_competency_guard();

do $$
declare
  t text;
begin
  foreach t in array array['appraisal_competency', 'appraisal_competency_set'] loop
    execute format('create trigger %I before update on %I for each row execute function hrms_touch()', t || '_touch', t);
    execute format('create trigger %I before delete on %I for each row execute function hrms_no_delete()', t || '_no_delete', t);
  end loop;
end $$;
