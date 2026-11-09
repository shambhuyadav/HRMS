-- 0178 Due dates of appraisal tasks (I-40 item 6; F2 Appraisal Reviewer "Overdue review tasks"; DF17 "overdue means pending
-- with due date < company-local today"). Decided under owner delegation, 6 Nov 2026 (owner chose process rules only): I-77
-- item 5. Synthetic data only.
--
-- * The manager's rating (step 1 of the appraisal route) is due on the last day of the cycle's manager-rating window, or on
--   the last day of a later authorised exception recorded for that appraisal and stage (FR-040).
-- * A reviewer confirmation (level 1, step 2 of the appraisal route; level 2, the second-review route) is due on the cycle's
--   review due date (0176), which HR sets with the cycle schedule.
-- A due date is held on the task as the last instant of that date in the company's business time zone, so the dashboard's
-- rule (business date of due_at < today) reads it as an inclusive date. Every task of these kinds is dated when it is
-- created, whoever creates it (the engine's next step, a second-level review, a reroute), and pending tasks follow a change
-- of the cycle's dates or a new exception. A task whose date is not scheduled has no due date and is never overdue.

create function hrms_appraisal_task_due_at(p_company uuid, p_instance uuid, p_step uuid) returns timestamptz language sql stable as $$
  with t as (
    select i.transaction_kind as kind, i.transaction_id, s.sequence
      from approval_instance i
      join workflow_step s on s.company_id = i.company_id and s.id = p_step
     where i.company_id = p_company and i.id = p_instance
  ), due as (
    select case
             when t.kind = 'appraisal' and t.sequence = 1 then (
               select greatest(c.rating_closes_on,
                               (select max(x.valid_until) from appraisal_window_exception x
                                 where x.company_id = a.company_id and x.appraisal_id = a.id and x.stage = 'MANAGER_RATING'))
                 from appraisal a join appraisal_cycle c on c.company_id = a.company_id and c.id = a.cycle_id
                where a.company_id = p_company and a.transaction_id = t.transaction_id)
             when t.kind = 'appraisal' then (
               select c.review_due_on from appraisal a join appraisal_cycle c on c.company_id = a.company_id and c.id = a.cycle_id
                where a.company_id = p_company and a.transaction_id = t.transaction_id)
             when t.kind = 'appraisal_second_review' then (
               select c.review_due_on from appraisal_second_review sr
                 join appraisal a on a.company_id = sr.company_id and a.id = sr.appraisal_id
                 join appraisal_cycle c on c.company_id = a.company_id and c.id = a.cycle_id
                where sr.company_id = p_company and sr.transaction_id = t.transaction_id)
           end as day
      from t
  )
  select ((due.day + 1)::timestamp at time zone co.business_timezone) - interval '1 microsecond'
    from due join company co on co.id = p_company
   where due.day is not null
$$;

create function hrms_appraisal_task_due() returns trigger language plpgsql as $$
begin
  if new.due_at is null and exists (select 1 from approval_instance i where i.company_id = new.company_id and i.id = new.instance_id
                                       and i.transaction_kind in ('appraisal', 'appraisal_second_review')) then
    new.due_at := hrms_appraisal_task_due_at(new.company_id, new.instance_id, new.step_id);
  end if;
  return new;
end $$;
create trigger approval_task_appraisal_due before insert on approval_task for each row execute function hrms_appraisal_task_due();

-- Pending tasks of one cycle's appraisals (their own route and any second-level review) take the cycle's current dates.
create function hrms_appraisal_refresh_task_due(p_company uuid, p_cycle uuid, p_appraisal uuid, p_actor uuid) returns void language sql as $$
  update approval_task t set due_at = hrms_appraisal_task_due_at(t.company_id, t.instance_id, t.step_id), updated_by = coalesce(p_actor, t.updated_by)
    from approval_instance i
   where i.company_id = t.company_id and i.id = t.instance_id and i.state = 'ACTIVE'
     and t.company_id = p_company and t.state = 'PENDING'
     and i.transaction_id in (
       select a.transaction_id from appraisal a where a.company_id = p_company and a.cycle_id = p_cycle and (p_appraisal is null or a.id = p_appraisal)
       union all
       select sr.transaction_id from appraisal_second_review sr join appraisal a on a.company_id = sr.company_id and a.id = sr.appraisal_id
        where sr.company_id = p_company and a.cycle_id = p_cycle and (p_appraisal is null or a.id = p_appraisal))
     and t.due_at is distinct from hrms_appraisal_task_due_at(t.company_id, t.instance_id, t.step_id)
$$;

create function hrms_appraisal_cycle_task_due() returns trigger language plpgsql as $$
begin
  perform hrms_appraisal_refresh_task_due(new.company_id, new.id, null, new.updated_by);
  return null;
end $$;
create trigger appraisal_cycle_task_due after update of rating_closes_on, review_due_on on appraisal_cycle for each row
  when (old.rating_closes_on is distinct from new.rating_closes_on or old.review_due_on is distinct from new.review_due_on)
  execute function hrms_appraisal_cycle_task_due();

create function hrms_appraisal_exception_task_due() returns trigger language plpgsql as $$
begin
  perform hrms_appraisal_refresh_task_due(new.company_id, a.cycle_id, a.id, new.recorded_by)
     from appraisal a where a.company_id = new.company_id and a.id = new.appraisal_id;
  return null;
end $$;
create trigger appraisal_window_exception_task_due after insert on appraisal_window_exception for each row
  when (new.stage = 'MANAGER_RATING') execute function hrms_appraisal_exception_task_due();

-- Tasks already open take their dates now.
update approval_task t set due_at = hrms_appraisal_task_due_at(t.company_id, t.instance_id, t.step_id)
  from approval_instance i
 where i.company_id = t.company_id and i.id = t.instance_id and i.state = 'ACTIVE' and t.state = 'PENDING' and t.due_at is null
   and i.transaction_kind in ('appraisal', 'appraisal_second_review');
