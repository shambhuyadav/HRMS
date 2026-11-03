-- 0116 Expense policy maintenance guards (FR-078; BR-019; DF06; DB047-DB049; C4).
--
-- An expense policy revision applies to the whole company on the dates of its period (its rules carry the grade and
-- location), so two revisions in force in overlapping periods would leave every line of the overlap POLICY_AMBIGUOUS. Such a
-- pair is rejected here, whatever path activates it. A retired revision stays in force until its effective end, so that a
-- claim for an earlier expense date is still judged by it (DF06 "the policy effective on the expense date"); retired without
-- an end, it never applies again. Policy changes of one company run one after another, and submissions take the same key
-- shared (the key in expense/policies.ts), so a revision can never be end-dated past a submission still in flight.
--
-- DB048 "immutable once referenced": once a revision leaves DRAFT its values and rules never change, so a submitted claim
-- keeps the rules it was judged under (FR-078). Only its end may come earlier, and never before a date a submitted
-- revision already used it for.

create index expense_revision_policy_idx on expense_revision (company_id, policy_id) where submitted_at is not null;

-- The other revisions in force whose period overlaps this one's.
create function hrms_expense_policy_conflicts(p_company uuid, p_policy uuid) returns table (policy_id uuid) language sql stable as $$
  select o.id
    from expense_policy me
    join expense_policy o on o.company_id = me.company_id and o.id <> me.id
   where me.company_id = p_company and me.id = p_policy
     and (o.state = 'ACTIVE' or (o.state = 'RETIRED' and o.effective_to is not null))
     and daterange(me.effective_from, me.effective_to, '[)') && daterange(o.effective_from, o.effective_to, '[)')
$$;

create function hrms_expense_policy_no_overlap() returns trigger language plpgsql as $$
begin
  if new.state = 'DRAFT' or (new.state = 'RETIRED' and new.effective_to is null) then
    return null;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('expense:policy:' || new.company_id::text, 0));
  if exists (select 1 from hrms_expense_policy_conflicts(new.company_id, new.id)) then
    raise exception 'expense policy % overlaps another revision in force', new.id using errcode = '23514';
  end if;
  return null;
end $$;
create trigger expense_policy_no_overlap after insert or update of state, effective_from, effective_to on expense_policy
  for each row execute function hrms_expense_policy_no_overlap();

-- The last expense date a submitted revision used this policy revision for (null when none has).
create function hrms_expense_policy_last_used(p_company uuid, p_policy uuid) returns date language sql stable as $$
  select max(l.expense_date)
    from expense_revision r
    join expense_line l on l.company_id = r.company_id and l.revision_id = r.id
   where r.company_id = p_company and r.policy_id = p_policy and r.submitted_at is not null
$$;

-- BEFORE each update of a policy revision: a draft is free until activation, which its last editor does not perform (0012
-- checks the creator). From then on the values are fixed and the period may only end earlier, not before a used date.
create function hrms_expense_policy_frozen() returns trigger language plpgsql as $$
declare
  used date;
begin
  if old.state = 'DRAFT' then
    if new.state <> 'DRAFT' and old.updated_by is not null and old.updated_by = new.activated_by then
      raise exception 'the last editor of an expense policy draft cannot activate it' using errcode = '23514';
    end if;
    return new;
  end if;
  if new.state = 'DRAFT' then
    raise exception 'an activated expense policy does not return to draft' using errcode = '23514';
  end if;
  if old.state = 'RETIRED' and new.state <> 'RETIRED' then
    raise exception 'a retired expense policy stays retired' using errcode = '23514';
  end if;
  if (new.code, new.revision, new.currency_code, new.submission_window_days, new.high_value_threshold, new.effective_from, new.activated_by, new.activated_at)
     is distinct from (old.code, old.revision, old.currency_code, old.submission_window_days, old.high_value_threshold, old.effective_from, old.activated_by, old.activated_at) then
    raise exception 'the values of an activated expense policy are immutable; create a new revision' using errcode = '23514';
  end if;
  if old.state = 'RETIRED' and old.effective_to is null and new.effective_to is not null then
    raise exception 'a retired expense policy without an end stays out of force' using errcode = '23514';
  end if;
  if old.effective_to is not null and (new.effective_to > old.effective_to or (new.state = 'ACTIVE' and new.effective_to is null)) then
    raise exception 'the period of an activated expense policy may only end earlier' using errcode = '23514';
  end if;
  -- A retirement with no end takes the revision out of force from its first day.
  if new.effective_to is distinct from old.effective_to or (old.state = 'ACTIVE' and new.state = 'RETIRED' and new.effective_to is null) then
    used := hrms_expense_policy_last_used(new.company_id, new.id);
    if used is not null and used >= coalesce(new.effective_to, new.effective_from) then
      raise exception 'expense policy % was used for a claim dated %, so its period cannot end by then', new.id, used using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger expense_policy_frozen before update on expense_policy for each row execute function hrms_expense_policy_frozen();

-- Rules are part of the draft: once a revision left DRAFT they never change. After the row changed, so an insert that
-- ON CONFLICT DO NOTHING skips (provisioning run again) is no change.
create function hrms_expense_policy_rule_draft_only() returns trigger language plpgsql as $$
declare
  c uuid := case tg_op when 'DELETE' then old.company_id else new.company_id end;
  p uuid := case tg_op when 'DELETE' then old.policy_id else new.policy_id end;
begin
  if exists (select 1 from expense_policy where company_id = c and id = p and state <> 'DRAFT') then
    raise exception 'the rules of an activated expense policy are immutable; create a new revision' using errcode = '23514';
  end if;
  return null;
end $$;
create trigger expense_policy_rule_draft_only after insert or update or delete on expense_policy_rule
  for each row execute function hrms_expense_policy_rule_draft_only();

-- DB049 "no ambiguous equal-priority matching rule": for a category, a grade-only rule and a location-only rule tie for the
-- employee who has both, unless a rule naming that grade and location settles it. Read by activation and the policy list;
-- submission refuses whichever tie it actually meets (POLICY_AMBIGUOUS), so this is what can be told in advance.
create function hrms_expense_policy_tied_rules(p_company uuid, p_policy uuid) returns table (category_id uuid, grade_id uuid, location_id uuid) language sql stable as $$
  select g.category_id, g.grade_id, l.location_id
    from expense_policy_rule g
    join expense_policy_rule l on l.company_id = g.company_id and l.policy_id = g.policy_id and l.category_id = g.category_id
                              and l.grade_id is null and l.location_id is not null
   where g.company_id = p_company and g.policy_id = p_policy and g.grade_id is not null and g.location_id is null
     and not exists (select 1 from expense_policy_rule r
                      where r.company_id = g.company_id and r.policy_id = g.policy_id and r.category_id = g.category_id
                        and r.grade_id = g.grade_id and r.location_id = l.location_id)
$$;

-- What a limit means rests on its category: a category's code and limit basis are fixed at creation.
create function hrms_expense_category_identity() returns trigger language plpgsql as $$
begin
  if (new.code, new.limit_basis) is distinct from (old.code, old.limit_basis) then
    raise exception 'the code and limit basis of an expense category are fixed; create a new category' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger expense_category_identity before update on expense_category for each row execute function hrms_expense_category_identity();
