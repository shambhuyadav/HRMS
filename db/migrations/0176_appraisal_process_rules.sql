-- 0176 Appraisal process rules decided under owner delegation, 6 Nov 2026 (owner chose process rules only): I-77 items 1 to 4
-- (FR-041, FR-042, FR-043; BR-013; BR-014; DF04 "self/manager/reviewer scores"; F1 "Appraisal"). Synthetic data only.
--
-- * Review levels (FR-043 "Level 1 completes at manager approval"; BR-013 "one-level manager review or two-level ..."): a cycle
--   may now set 0 reviewer levels, so the manager's approval completes the appraisal. One level stays the default (F1 "One
--   reviewer step is the default"), two only when set explicitly. The appraisal goes SUBMITTED -> APPROVED in that case.
-- * KRA review (FR-041 "KRA Setting, KRA Review"): a cycle may require the goal set to be reviewed before the goals take
--   effect. The reviewer is never the person who set the goals nor the appraised employee; the employee's self-entry is
--   submitted only against reviewed goals. Required for new cycles by default; cycles created before this migration keep the
--   I-23 rule (no review) they were created under.
-- * Rating mode (FR-042 "Manual or formula-based target rating is configured"; BR-014): FORMULA (the F1 weighted manager
--   result is the final rating, the default) or MANUAL (the manager also enters an overall rating, an integer 1..5 on the F1
--   scale, which becomes the final rating; the weighted result is still kept beside it).
-- * Reviewer scores (FR-043 "Preserve self, manager and reviewer ratings separately"; DF04): each reviewer level's
--   confirmation carries one overall score (integer 1..5), kept per revision and level, append-only. It never changes the
--   final rating (F1: the reviewer confirms; a reviewer who disagrees returns the revision).
-- * The review due date (I-40 item 6): the date by which reviewer confirmations are due. 0178 dates the tasks from it.
-- Review levels, goal review and rating mode are fixed once an appraisal of the cycle has been submitted.

-- ---------------------------------------------------------------------------------------------------------------
-- Cycle rules
-- ---------------------------------------------------------------------------------------------------------------
alter table appraisal_cycle drop constraint appraisal_cycle_approval_levels_check;
alter table appraisal_cycle add constraint appraisal_cycle_approval_levels_check check (approval_levels in (0, 1, 2));
alter table appraisal_cycle add column goal_review_required boolean not null default false;
alter table appraisal_cycle alter column goal_review_required set default true;
alter table appraisal_cycle add column rating_mode text not null default 'FORMULA' check (rating_mode in ('FORMULA', 'MANUAL'));
alter table appraisal_cycle add column review_due_on date;
-- Reviewer confirmations follow the manager's rating: they are not due before the rating window closes.
alter table appraisal_cycle add constraint appraisal_cycle_review_due_after_rating check (review_due_on >= rating_closes_on);

create or replace function hrms_appraisal_cycle_guard() returns trigger language plpgsql as $$
begin
  if (new.code, new.start_date, new.end_date) is distinct from (old.code, old.start_date, old.end_date) then
    raise exception 'appraisal cycle code and period are immutable' using errcode = '23514';
  end if;
  if old.state = 'CLOSED' then
    raise exception 'a closed appraisal cycle is final' using errcode = '23514';
  end if;
  if (new.approval_levels, new.goal_review_required, new.rating_mode) is distinct from (old.approval_levels, old.goal_review_required, old.rating_mode) and exists (
    select 1 from appraisal_revision r join appraisal a on a.company_id = r.company_id and a.id = r.appraisal_id
     where a.company_id = new.company_id and a.cycle_id = new.id and r.submitted_at is not null) then
    raise exception 'reviewer levels, goal review and rating mode are fixed once an appraisal of the cycle has been submitted' using errcode = '23514';
  end if;
  if new.state = 'CLOSED' and exists (select 1 from appraisal a where a.company_id = new.company_id and a.cycle_id = new.id
                                         and a.state not in ('APPROVED', 'CANCELLED')) then
    raise exception 'an appraisal cycle with unfinished appraisals cannot be closed' using errcode = '23514';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- KRA review: who last set the goal set, and who reviewed it
-- ---------------------------------------------------------------------------------------------------------------
alter table appraisal add column goals_set_by uuid references user_account (id) on delete restrict;
alter table appraisal add column goals_set_at timestamptz;
alter table appraisal add column goals_reviewed_by uuid references user_account (id) on delete restrict;
alter table appraisal add column goals_reviewed_at timestamptz;
alter table appraisal add constraint appraisal_goals_set_pair check ((goals_set_by is null) = (goals_set_at is null));
alter table appraisal add constraint appraisal_goals_reviewed_pair check ((goals_reviewed_by is null) = (goals_reviewed_at is null));
alter table appraisal add constraint appraisal_goals_reviewed_after_set check (goals_reviewed_by is null or goals_set_by is not null);

create function hrms_appraisal_goal_review_guard() returns trigger language plpgsql as $$
declare
  required boolean;
  goal_count integer;
  goal_total integer;
begin
  if tg_op = 'INSERT' then
    if new.goals_reviewed_by is not null then
      raise exception 'a goal set is reviewed after it is set, never on enrolment' using errcode = '23514';
    end if;
    return new;
  end if;
  -- A new goal set starts unreviewed, and a review is undone only by a new goal set.
  if (new.goals_set_by, new.goals_set_at) is distinct from (old.goals_set_by, old.goals_set_at) and new.goals_reviewed_by is not null then
    raise exception 'a changed goal set starts unreviewed' using errcode = '23514';
  end if;
  if old.goals_reviewed_by is not null and new.goals_reviewed_by is null and new.goals_set_at is not distinct from old.goals_set_at then
    raise exception 'a goal review is undone only by setting the goals again' using errcode = '23514';
  end if;
  if new.goals_reviewed_by is not null and (new.goals_reviewed_by, new.goals_reviewed_at) is distinct from (old.goals_reviewed_by, old.goals_reviewed_at) then
    -- Maker and checker: the person who set the goals never reviews them, nor does the appraised employee.
    if new.goals_reviewed_by = new.goals_set_by then
      raise exception 'goals are reviewed by someone other than the person who set them' using errcode = '23514';
    end if;
    if exists (select 1 from user_employee_link l where l.company_id = new.company_id and l.user_id = new.goals_reviewed_by and l.employee_id = new.employee_id) then
      raise exception 'nobody reviews the goals of their own appraisal' using errcode = '23514';
    end if;
    if new.state <> 'DRAFT' or exists (select 1 from appraisal_revision r where r.company_id = new.company_id and r.appraisal_id = new.id and r.submitted_at is not null) then
      raise exception 'goals are reviewed before the appraisal is first submitted' using errcode = '23514';
    end if;
    select c.goal_review_required into required from appraisal_cycle c where c.company_id = new.company_id and c.id = new.cycle_id;
    if required is distinct from true then
      raise exception 'the cycle does not review goals' using errcode = '23514';
    end if;
    select count(*), coalesce(sum(weight), 0) into goal_count, goal_total from appraisal_item where company_id = new.company_id and appraisal_id = new.id and active;
    if goal_count = 0 or goal_total <> 100 then
      raise exception 'only a complete goal set (weights totalling exactly 100) is reviewed' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger appraisal_goal_review_guard before insert or update on appraisal for each row execute function hrms_appraisal_goal_review_guard();

-- Goals change only before the first submission (as before), only while the goal set is unreviewed, and only by the person
-- recorded as setting it (so the maker-checker check above compares the right people).
create or replace function hrms_appraisal_item_guard() returns trigger language plpgsql as $$
declare
  a record;
begin
  select state, goals_set_by, goals_reviewed_at into a from appraisal where company_id = new.company_id and id = new.appraisal_id;
  if a.state is distinct from 'DRAFT' or exists (
    select 1 from appraisal_revision r where r.company_id = new.company_id and r.appraisal_id = new.appraisal_id and r.submitted_at is not null) then
    raise exception 'goals are fixed once the appraisal has been submitted' using errcode = '23514';
  end if;
  if a.goals_reviewed_at is not null then
    raise exception 'reviewed goals are fixed; set the goals again to change them' using errcode = '23514';
  end if;
  if a.goals_set_by is not null and coalesce(new.updated_by, new.created_by) is distinct from a.goals_set_by then
    raise exception 'goals are changed by the person recorded as setting them' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' then
    if (new.appraisal_id, new.item_kind) is distinct from (old.appraisal_id, old.item_kind) then
      raise exception 'goal identity is immutable' using errcode = '23514';
    end if;
    if not old.active then
      raise exception 'a removed goal stays removed' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Revisions: 0 reviewer levels may be pinned; the manager's manual overall rating is part of the manager's rating
-- ---------------------------------------------------------------------------------------------------------------
alter table appraisal_revision drop constraint appraisal_revision_approval_levels_check;
alter table appraisal_revision add constraint appraisal_revision_approval_levels_check check (approval_levels in (0, 1, 2));
alter table appraisal_revision add column manager_overall_rating smallint check (manager_overall_rating between 1 and 5);

create or replace function hrms_appraisal_revision_guard() returns trigger language plpgsql as $$
declare
  c record;
  goals_reviewed boolean;
begin
  if tg_op = 'INSERT' then
    if new.state <> 'DRAFT' then
      raise exception 'an appraisal revision starts as a draft' using errcode = '23514';
    end if;
    if new.revision <> coalesce((select max(revision) from appraisal_revision where company_id = new.company_id and appraisal_id = new.appraisal_id), 0) + 1 then
      raise exception 'appraisal revisions are consecutive' using errcode = '23514';
    end if;
    return new;
  end if;
  if (new.appraisal_id, new.revision) is distinct from (old.appraisal_id, old.revision) then
    raise exception 'appraisal revision identity is immutable' using errcode = '23514';
  end if;
  if old.state in ('CONFIRMED', 'RETURNED', 'CANCELLED') then
    raise exception 'a closed appraisal revision is final' using errcode = '23514';
  end if;
  if new.state <> old.state and (old.state, new.state) not in (
       ('DRAFT', 'SUBMITTED'), ('DRAFT', 'CANCELLED'), ('SUBMITTED', 'RATED'), ('SUBMITTED', 'RETURNED'), ('SUBMITTED', 'CANCELLED'),
       ('RATED', 'CONFIRMED'), ('RATED', 'RETURNED'), ('RATED', 'CANCELLED')) then
    raise exception 'appraisal revision transition % -> % is not allowed', old.state, new.state using errcode = '23514';
  end if;
  -- The self-entry is fixed once submitted.
  if old.state <> 'DRAFT' and (new.self_comment, new.submitted_by, new.submitted_at, new.approval_levels)
       is distinct from (old.self_comment, old.submitted_by, old.submitted_at, old.approval_levels) then
    raise exception 'a submitted self-entry is immutable' using errcode = '23514';
  end if;
  -- The manager's rating (with the manual overall rating) is prepared while the revision is submitted, fixed once rated, and
  -- never written by the appraised employee (FR-043: an employee cannot replace a manager rating).
  if (new.manager_comment, new.rated_by, new.rated_at, new.weighted_result, new.manager_overall_rating)
       is distinct from (old.manager_comment, old.rated_by, old.rated_at, old.weighted_result, old.manager_overall_rating) then
    if old.state <> 'SUBMITTED' then
      raise exception 'the manager rating can change only while it is being prepared' using errcode = '23514';
    end if;
    if exists (select 1 from appraisal a join user_employee_link l on l.company_id = a.company_id and l.employee_id = a.employee_id
                where a.company_id = new.company_id and a.id = new.appraisal_id and l.user_id in (new.updated_by, new.rated_by)) then
      raise exception 'an employee can never enter or replace a manager rating' using errcode = '23514';
    end if;
  end if;
  if new.state <> old.state and new.state in ('SUBMITTED', 'RATED') then
    select cy.goal_review_required, cy.rating_mode, a.goals_reviewed_at is not null as reviewed into c
      from appraisal a join appraisal_cycle cy on cy.company_id = a.company_id and cy.id = a.cycle_id
     where a.company_id = new.company_id and a.id = new.appraisal_id;
    -- KRA review: the self-entry is submitted only against goals that took effect.
    if new.state = 'SUBMITTED' and c.goal_review_required and not c.reviewed then
      raise exception 'the goals must be reviewed before the self-entry is submitted' using errcode = '23514';
    end if;
    -- Rating mode: a manual cycle's rating carries the overall rating; a formula cycle's never does.
    if new.state = 'RATED' and (c.rating_mode = 'MANUAL') <> (new.manager_overall_rating is not null) then
      raise exception 'the overall rating is entered exactly when the cycle rates manually' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Reviewer scores: one overall score per revision and reviewer level, written with that level's confirmation
-- ---------------------------------------------------------------------------------------------------------------
create table appraisal_review_score (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references company (id) on delete restrict,
  appraisal_id  uuid not null,
  revision_id   uuid not null,
  level         smallint not null check (level in (1, 2)),
  -- F1 scale: an integer 1..5.
  score         smallint not null check (score between 1 and 5),
  decision_id   uuid not null,
  created_at    timestamptz not null default now(),
  created_by    uuid not null references user_account (id) on delete restrict,
  unique (company_id, id),
  unique (company_id, revision_id, level),
  unique (company_id, decision_id),
  foreign key (company_id, appraisal_id, revision_id) references appraisal_revision (company_id, appraisal_id, id) on delete restrict,
  foreign key (company_id, decision_id) references approval_decision (company_id, id) on delete restrict
);

create function hrms_appraisal_review_score_guard() returns trigger language plpgsql as $$
declare
  d record;
begin
  select dd.decision, dd.actor_user_id, i.transaction_id, i.transaction_kind, i.transaction_revision, p.action into d
    from approval_decision dd
    join approval_task t on t.company_id = dd.company_id and t.id = dd.task_id
    join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id
    join workflow_step s on s.company_id = t.company_id and s.id = t.step_id
    join permission p on p.id = s.permission_id
   where dd.company_id = new.company_id and dd.id = new.decision_id;
  if d.decision is distinct from 'APPROVE' or d.action is distinct from 'confirm' or d.actor_user_id is distinct from new.created_by then
    raise exception 'a reviewer score is part of the scorer''s own confirmation' using errcode = '23514';
  end if;
  if not ((new.level = 1 and d.transaction_kind = 'appraisal' and exists (
             select 1 from appraisal a join appraisal_revision r on r.company_id = a.company_id and r.appraisal_id = a.id
              where a.company_id = new.company_id and a.id = new.appraisal_id and a.transaction_id = d.transaction_id
                and r.id = new.revision_id and r.revision = d.transaction_revision))
       or (new.level = 2 and d.transaction_kind = 'appraisal_second_review' and exists (
             select 1 from appraisal_second_review sr
              where sr.company_id = new.company_id and sr.appraisal_id = new.appraisal_id and sr.revision_id = new.revision_id
                and sr.transaction_id = d.transaction_id))) then
    raise exception 'a reviewer score belongs to that level''s confirmation of this revision' using errcode = '23514';
  end if;
  if (select state from appraisal_revision where company_id = new.company_id and id = new.revision_id) is distinct from 'RATED' then
    raise exception 'a reviewer scores a rated revision' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger appraisal_review_score_guard before insert on appraisal_review_score for each row execute function hrms_appraisal_review_score_guard();
create trigger appraisal_review_score_append_only before update or delete on appraisal_review_score for each row execute function hrms_append_only();

-- ---------------------------------------------------------------------------------------------------------------
-- A one-level appraisal completes at the manager's approval (BR-013; FR-043).
-- ---------------------------------------------------------------------------------------------------------------
insert into transaction_transition (kind, from_state, to_state) values ('appraisal', 'SUBMITTED', 'APPROVED');
