-- 0177 The appraisal route's reviewer step becomes conditional (BR-013 one-level manager review; FR-043 "Level 1 completes at
-- manager approval"; F1 "One reviewer step is the default"; DF03 "Pin the effective workflow ... revision on submission").
-- Decided under owner delegation, 6 Nov 2026 (owner chose process rules only): I-77 item 2. Synthetic data only.
--
-- Step 2 of the 'appraisal' route (reviewer level 1) applies when the revision pinned at least one reviewer level; the
-- appraisal module evaluates condition APPRAISAL_REVIEWER_LEVEL from that pinned value. A route no appraisal has used yet is
-- changed in place; a route already used is immutable (0002), so it is retired now and the next revision, identical except
-- for the condition, takes over. Approvals already started stay on the revision they pinned, where step 2 always applies:
-- their revisions pinned one or two reviewer levels, because zero did not exist before 0176.

alter table workflow_step drop constraint workflow_step_condition_code_check;
alter table workflow_step add constraint workflow_step_condition_code_check check (condition_code in ('EXPENSE_HIGH_VALUE', 'APPRAISAL_REVIEWER_LEVEL'));

update workflow_step s set condition_code = 'APPRAISAL_REVIEWER_LEVEL'
  from workflow_definition w
 where w.company_id = s.company_id and w.id = s.workflow_id and w.kind = 'appraisal' and s.sequence = 2 and s.condition_code is null
   and not exists (select 1 from approval_instance ai where ai.company_id = w.company_id and ai.workflow_id = w.id);

do $$
declare
  w record;
  next_id uuid;
begin
  for w in
    select d.id, d.company_id, d.created_by from workflow_definition d
     where d.kind = 'appraisal' and d.active and d.effective_from <= now() and (d.effective_to is null or d.effective_to > now())
       and exists (select 1 from workflow_step s where s.company_id = d.company_id and s.workflow_id = d.id and s.sequence = 2 and s.condition_code is null)
  loop
    update workflow_definition set effective_to = now() where company_id = w.company_id and id = w.id;
    insert into workflow_definition (company_id, kind, revision, effective_from, active, created_by, updated_by)
    values (w.company_id, 'appraisal', (select max(revision) + 1 from workflow_definition where company_id = w.company_id and kind = 'appraisal'), now(), true, w.created_by, w.created_by)
    returning id into next_id;
    insert into workflow_step (company_id, workflow_id, sequence, permission_id, selection_rule, completion_rule, condition_code, created_by, updated_by)
    select s.company_id, next_id, s.sequence, s.permission_id, s.selection_rule, s.completion_rule,
           case when s.sequence = 2 then 'APPRAISAL_REVIEWER_LEVEL' else s.condition_code end, w.created_by, w.created_by
      from workflow_step s where s.company_id = w.company_id and s.workflow_id = w.id;
  end loop;
end $$;
