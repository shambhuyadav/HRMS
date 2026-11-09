-- 0231 Competencies and configurable sections in an appraisal, and the combined formula (FR-041; FR-042; BR-014; F1 "Appraisal";
-- DF02; OQ-10; E11 "Section visibility settings", "Grade competency mapping", "Formula and manual rating information"; I-86, decided
-- under owner delegation, 6 Nov 2026). Synthetic data only.
--
-- * Cycle scoring split: each cycle keeps its own copy of the goals / competencies split (whole percentages adding to 100), taken
--   from the dated company setting (0230) in force on its start date unless HR sets it on the cycle. Cycles created before this
--   migration keep the I-23 rule they were created under: goals 100, competencies 0 (not assessed). Whether a cycle assesses
--   competencies at all (competency weight above 0) is fixed once an appraisal is enrolled in it; the split, like the other cycle
--   rules, is fixed once an appraisal of the cycle has been submitted.
-- * Cycle sections (FR-042 "configurable improvement, training, activity-performance and stretched-KPI sections"): the cycle lists
--   the sections it includes, none by default. Who fills each one: improvement areas, the manager; training needs, activity
--   performance and stretched KPIs, the employee in the self-entry and the manager in the rating. No section is scored. An included
--   section's part must be filled before that party submits; an excluded section takes no entries and never blocks a submission.
-- * Appraisal competencies: copied at enrolment, in the enrolment's own transaction, from the set mapped to the employee's grade (and
--   designation) on that day, then fixed: code, name, description, the five behavioural indicators and the weight are kept as they
--   were copied, whatever the master does later. Weights total exactly 100, from one set.
-- * Competency entries (per revision and competency): self score and comment, manager score and comment, integers 1..5, under the
--   same guard as the goal entries (0035): the self part changes only in a draft, the manager part only while the rating is being
--   prepared and never by the appraised employee.
-- * Section entries (per revision, section and party): the employee's text (own self-entry, the own-ESS `self` group) and the
--   manager's text (the confidential `rating` group).
-- * Results (I-86 formula): goal result G = sum(goal weight x manager score) / 100 and competency result C = sum(competency weight x
--   manager score) / 100, each exact at two decimals because whole-number weights total 100; the weighted result is
--   (goal split x G + competency split x C) / 100, exact at four decimals, rounded once, half up, to the two decimals F1 displays;
--   without competencies it is G. Checked here: each result against the entries when the rating is submitted, the split against the
--   cycle's, and the weighted result against both. Written once, with the rating.

-- ---------------------------------------------------------------------------------------------------------------
-- Section catalogue (fixed meanings; the cycle chooses which apply)
-- ---------------------------------------------------------------------------------------------------------------
create function hrms_appraisal_section_party(section text, party text) returns boolean language sql immutable as $$
  select case section
           when 'IMPROVEMENT_AREAS' then party = 'MANAGER'
           when 'TRAINING_NEEDS' then party in ('EMPLOYEE', 'MANAGER')
           when 'ACTIVITY_PERFORMANCE' then party in ('EMPLOYEE', 'MANAGER')
           when 'STRETCHED_KPIS' then party in ('EMPLOYEE', 'MANAGER')
           else false
         end
$$;

-- A set of known section codes without repeats or blanks.
create function hrms_appraisal_sections_valid(sections text[]) returns boolean language sql immutable as $$
  select cardinality(sections) = 0
      or coalesce(array_ndims(sections) = 1
         and not exists (select 1 from unnest(sections) as u (v) where u.v is null or not hrms_appraisal_section_party(u.v, 'MANAGER'))
         and cardinality(sections) = (select count(distinct u.v) from unnest(sections) as u (v)), false)
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Cycle: scoring split and sections
-- ---------------------------------------------------------------------------------------------------------------
alter table appraisal_cycle add column goal_weight_percent smallint not null default 100 check (goal_weight_percent between 1 and 100);
alter table appraisal_cycle add column competency_weight_percent smallint not null default 0 check (competency_weight_percent between 0 and 99);
alter table appraisal_cycle add constraint appraisal_cycle_split_total check (goal_weight_percent + competency_weight_percent = 100);
alter table appraisal_cycle add column sections text[] not null default '{}' check (hrms_appraisal_sections_valid(sections));

create or replace function hrms_appraisal_cycle_guard() returns trigger language plpgsql as $$
begin
  if (new.code, new.start_date, new.end_date) is distinct from (old.code, old.start_date, old.end_date) then
    raise exception 'appraisal cycle code and period are immutable' using errcode = '23514';
  end if;
  if old.state = 'CLOSED' then
    raise exception 'a closed appraisal cycle is final' using errcode = '23514';
  end if;
  if (new.approval_levels, new.goal_review_required, new.rating_mode, new.goal_weight_percent, new.competency_weight_percent, new.sections)
       is distinct from (old.approval_levels, old.goal_review_required, old.rating_mode, old.goal_weight_percent, old.competency_weight_percent, old.sections)
     and exists (
    select 1 from appraisal_revision r join appraisal a on a.company_id = r.company_id and a.id = r.appraisal_id
     where a.company_id = new.company_id and a.cycle_id = new.id and r.submitted_at is not null) then
    raise exception 'reviewer levels, goal review, rating mode, scoring split and sections are fixed once an appraisal of the cycle has been submitted' using errcode = '23514';
  end if;
  -- Competencies are copied at enrolment, so whether the cycle assesses them is fixed once an appraisal is enrolled.
  if (new.competency_weight_percent > 0) <> (old.competency_weight_percent > 0)
     and exists (select 1 from appraisal a where a.company_id = new.company_id and a.cycle_id = new.id) then
    raise exception 'whether a cycle assesses competencies is fixed once an appraisal is enrolled in it' using errcode = '23514';
  end if;
  if new.state = 'CLOSED' and exists (select 1 from appraisal a where a.company_id = new.company_id and a.cycle_id = new.id
                                         and a.state not in ('APPROVED', 'CANCELLED')) then
    raise exception 'an appraisal cycle with unfinished appraisals cannot be closed' using errcode = '23514';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Appraisal competencies: copied at enrolment from the employee's set, then fixed
-- ---------------------------------------------------------------------------------------------------------------
create table appraisal_competency_item (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references company (id) on delete restrict,
  appraisal_id   uuid not null,
  set_id         uuid not null,
  competency_id  uuid not null,
  sequence       integer not null check (sequence between 1 and 50),
  code           text not null check (code ~ '^[A-Z0-9][A-Z0-9_-]{0,39}$'),
  name           text not null check (btrim(name) <> '' and length(name) <= 200),
  description    text check (description is null or (btrim(description) <> '' and length(description) <= 2000)),
  indicators     text[] not null check (hrms_appraisal_indicators_valid(indicators)),
  weight         integer not null check (weight between 1 and 100),
  created_at     timestamptz not null default now(),
  created_by     uuid not null references user_account (id) on delete restrict,
  unique (company_id, id),
  unique (company_id, appraisal_id, id),
  unique (company_id, appraisal_id, competency_id),
  unique (company_id, appraisal_id, sequence),
  foreign key (company_id, appraisal_id) references appraisal (company_id, id) on delete restrict,
  foreign key (company_id, set_id, competency_id) references appraisal_competency_set_item (company_id, set_id, competency_id) on delete restrict
);
create index appraisal_competency_item_set_idx on appraisal_competency_item (company_id, set_id, competency_id);

create function hrms_appraisal_competency_item_guard() returns trigger language plpgsql as $$
declare
  a record;
begin
  select ap.state, ap.created_at, c.competency_weight_percent into a
    from appraisal ap join appraisal_cycle c on c.company_id = ap.company_id and c.id = ap.cycle_id
   where ap.company_id = new.company_id and ap.id = new.appraisal_id;
  if a.state is distinct from 'DRAFT' or a.created_at is distinct from now() then
    raise exception 'competencies are copied when the appraisal is created, then fixed' using errcode = '23514';
  end if;
  if a.competency_weight_percent = 0 then
    raise exception 'the cycle does not assess competencies' using errcode = '23514';
  end if;
  if not exists (select 1 from appraisal_competency_set_item si where si.company_id = new.company_id and si.set_id = new.set_id
                    and si.competency_id = new.competency_id and si.weight = new.weight) then
    raise exception 'an appraisal competency carries the weight of its set item' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger appraisal_competency_item_guard before insert on appraisal_competency_item for each row execute function hrms_appraisal_competency_item_guard();
create trigger appraisal_competency_item_append_only before update or delete on appraisal_competency_item for each row execute function hrms_append_only();

-- At commit an appraisal's competencies come from one set and their weights total exactly 100.
create function hrms_appraisal_competency_item_total() returns trigger language plpgsql as $$
declare
  t record;
begin
  select coalesce(sum(weight), 0) as total, count(distinct set_id) as sets into t
    from appraisal_competency_item where company_id = new.company_id and appraisal_id = new.appraisal_id;
  if t.total <> 100 or t.sets <> 1 then
    raise exception 'an appraisal''s competencies come from one set and their weights total exactly 100 (now %)', t.total using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger appraisal_competency_item_total after insert on appraisal_competency_item
  deferrable initially deferred for each row execute function hrms_appraisal_competency_item_total();

-- Per revision and competency: self and manager parts, guarded exactly as the goal entries are (hrms_appraisal_entry_guard, 0035).
create table appraisal_competency_entry (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references company (id) on delete restrict,
  appraisal_id     uuid not null,
  revision_id      uuid not null,
  item_id          uuid not null,
  self_score       smallint check (self_score between 1 and 5),
  self_comment     text check (self_comment is null or (btrim(self_comment) <> '' and length(self_comment) <= 2000)),
  manager_score    smallint check (manager_score between 1 and 5),
  manager_comment  text check (manager_comment is null or (btrim(manager_comment) <> '' and length(manager_comment) <= 2000)),
  created_at       timestamptz not null default now(),
  created_by       uuid references user_account (id) on delete restrict,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references user_account (id) on delete restrict,
  version          integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, revision_id, item_id),
  foreign key (company_id, appraisal_id, revision_id) references appraisal_revision (company_id, appraisal_id, id) on delete restrict,
  foreign key (company_id, appraisal_id, item_id) references appraisal_competency_item (company_id, appraisal_id, id) on delete restrict
);
create index appraisal_competency_entry_item_idx on appraisal_competency_entry (company_id, appraisal_id, item_id);
create trigger appraisal_competency_entry_guard before insert or update on appraisal_competency_entry for each row execute function hrms_appraisal_entry_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- Section entries: per revision, section and party (EMPLOYEE in the self-entry, MANAGER in the rating)
-- ---------------------------------------------------------------------------------------------------------------
create table appraisal_section_entry (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references company (id) on delete restrict,
  appraisal_id  uuid not null,
  revision_id   uuid not null,
  section       text not null check (section in ('IMPROVEMENT_AREAS', 'TRAINING_NEEDS', 'ACTIVITY_PERFORMANCE', 'STRETCHED_KPIS')),
  party         text not null check (party in ('EMPLOYEE', 'MANAGER')),
  -- Null: cleared (rows are never deleted).
  body          text check (body is null or (btrim(body) <> '' and length(body) <= 4000)),
  created_at    timestamptz not null default now(),
  created_by    uuid references user_account (id) on delete restrict,
  updated_at    timestamptz not null default now(),
  updated_by    uuid references user_account (id) on delete restrict,
  version       integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, revision_id, section, party),
  check (hrms_appraisal_section_party(section, party)),
  foreign key (company_id, appraisal_id, revision_id) references appraisal_revision (company_id, appraisal_id, id) on delete restrict
);
create index appraisal_section_entry_appraisal_idx on appraisal_section_entry (company_id, appraisal_id, section);

create function hrms_appraisal_section_entry_guard() returns trigger language plpgsql as $$
declare
  revision_state text;
begin
  select state into revision_state from appraisal_revision where company_id = new.company_id and id = new.revision_id;
  if tg_op = 'UPDATE' and (new.appraisal_id, new.revision_id, new.section, new.party) is distinct from (old.appraisal_id, old.revision_id, old.section, old.party) then
    raise exception 'appraisal section entry identity is immutable' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' and not exists (
       select 1 from appraisal a join appraisal_cycle c on c.company_id = a.company_id and c.id = a.cycle_id
        where a.company_id = new.company_id and a.id = new.appraisal_id and new.section = any (c.sections)) then
    raise exception 'only a section the cycle includes takes entries' using errcode = '23514';
  end if;
  if new.party = 'EMPLOYEE' and revision_state is distinct from 'DRAFT' then
    raise exception 'a submitted self-entry is immutable' using errcode = '23514';
  end if;
  if new.party = 'MANAGER' then
    if revision_state is distinct from 'SUBMITTED' then
      raise exception 'the manager rating can change only while it is being prepared' using errcode = '23514';
    end if;
    if exists (select 1 from appraisal a join user_employee_link l on l.company_id = a.company_id and l.employee_id = a.employee_id
                where a.company_id = new.company_id and a.id = new.appraisal_id and l.user_id = coalesce(new.updated_by, new.created_by)) then
      raise exception 'an employee can never enter or replace a manager rating' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger appraisal_section_entry_guard before insert or update on appraisal_section_entry for each row execute function hrms_appraisal_section_entry_guard();

do $$
declare
  t text;
begin
  foreach t in array array['appraisal_competency_entry', 'appraisal_section_entry'] loop
    execute format('create trigger %I before update on %I for each row execute function hrms_touch()', t || '_touch', t);
    execute format('create trigger %I before delete on %I for each row execute function hrms_no_delete()', t || '_no_delete', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Results: goal result, competency result and the split they were combined with, written once with the rating
-- ---------------------------------------------------------------------------------------------------------------
alter table appraisal_revision add column goal_result numeric(5, 2) check (goal_result between 1 and 5);
alter table appraisal_revision add column competency_result numeric(5, 2) check (competency_result between 1 and 5);
alter table appraisal_revision add column goal_weight_percent smallint check (goal_weight_percent between 1 and 99);
alter table appraisal_revision add column competency_weight_percent smallint check (competency_weight_percent between 1 and 99);
alter table appraisal_revision add constraint appraisal_revision_results_rated check (rated_at is not null or (goal_result is null and competency_result is null));
alter table appraisal_revision add constraint appraisal_revision_split_pinned
  check ((competency_result is null) = (competency_weight_percent is null) and (competency_weight_percent is null) = (goal_weight_percent is null));
-- The weighted result is the combination, rounded once, half up, to two decimals; without competencies it is the goal result.
alter table appraisal_revision add constraint appraisal_revision_combined_result check (
  case when competency_result is not null
         then goal_result is not null and goal_weight_percent + competency_weight_percent = 100
              and weighted_result = round((goal_weight_percent * goal_result + competency_weight_percent * competency_result) / 100, 2)
       when goal_result is not null then weighted_result = goal_result
       else true
  end);

create function hrms_appraisal_revision_scoring() returns trigger language plpgsql as $$
declare
  cy record;
  g record;
  k record;
begin
  if (new.goal_result, new.competency_result, new.goal_weight_percent, new.competency_weight_percent)
       is distinct from (old.goal_result, old.competency_result, old.goal_weight_percent, old.competency_weight_percent)
     and not (old.state = 'SUBMITTED' and new.state = 'RATED') then
    raise exception 'the goal and competency results are written once, with the rating' using errcode = '23514';
  end if;
  if new.state = old.state or new.state not in ('SUBMITTED', 'RATED') then
    return new;
  end if;
  select c.sections, c.goal_weight_percent, c.competency_weight_percent into cy
    from appraisal a join appraisal_cycle c on c.company_id = a.company_id and c.id = a.cycle_id
   where a.company_id = new.company_id and a.id = new.appraisal_id;
  if new.state = 'SUBMITTED' then
    if exists (select 1 from appraisal_competency_item ci
                 left join appraisal_competency_entry ce on ce.company_id = ci.company_id and ce.item_id = ci.id and ce.revision_id = new.id
                where ci.company_id = new.company_id and ci.appraisal_id = new.appraisal_id and ce.self_score is null) then
      raise exception 'every competency is self-scored before the self-entry is submitted' using errcode = '23514';
    end if;
    if exists (select 1 from unnest(cy.sections) as s (code)
                where hrms_appraisal_section_party(s.code, 'EMPLOYEE') and not exists (
                  select 1 from appraisal_section_entry se where se.company_id = new.company_id and se.revision_id = new.id
                     and se.section = s.code and se.party = 'EMPLOYEE' and se.body is not null)) then
      raise exception 'each included section the employee fills is filled before the self-entry is submitted' using errcode = '23514';
    end if;
    return new;
  end if;

  -- RATED: everything rated, every included manager section filled, and the results are the formula's.
  select count(*) filter (where e.manager_score is null) as unrated, sum(i.weight * e.manager_score) as total into g
    from appraisal_item i left join appraisal_entry e on e.company_id = i.company_id and e.item_id = i.id and e.revision_id = new.id
   where i.company_id = new.company_id and i.appraisal_id = new.appraisal_id and i.active;
  select count(*) as n, count(*) filter (where ce.manager_score is null) as unrated, sum(ci.weight * ce.manager_score) as total into k
    from appraisal_competency_item ci
    left join appraisal_competency_entry ce on ce.company_id = ci.company_id and ce.item_id = ci.id and ce.revision_id = new.id
   where ci.company_id = new.company_id and ci.appraisal_id = new.appraisal_id;
  if g.unrated > 0 or k.unrated > 0 then
    raise exception 'every goal and competency is rated before the rating is submitted' using errcode = '23514';
  end if;
  if exists (select 1 from unnest(cy.sections) as s (code)
              where hrms_appraisal_section_party(s.code, 'MANAGER') and not exists (
                select 1 from appraisal_section_entry se where se.company_id = new.company_id and se.revision_id = new.id
                   and se.section = s.code and se.party = 'MANAGER' and se.body is not null)) then
    raise exception 'each included section the manager fills is filled before the rating is submitted' using errcode = '23514';
  end if;
  if new.goal_result is distinct from g.total::numeric / 100 then
    raise exception 'the goal result is sum(weight x manager score) / 100 over the goals' using errcode = '23514';
  end if;
  if k.n = 0 then
    if new.competency_result is not null then
      raise exception 'an appraisal without competencies has no competency result' using errcode = '23514';
    end if;
  elsif new.competency_result is distinct from k.total::numeric / 100
        or (new.goal_weight_percent, new.competency_weight_percent) is distinct from (cy.goal_weight_percent, cy.competency_weight_percent) then
    raise exception 'the competency result is sum(weight x manager score) / 100 over the competencies, combined with the cycle''s split' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger appraisal_revision_scoring before update on appraisal_revision for each row execute function hrms_appraisal_revision_scoring();
