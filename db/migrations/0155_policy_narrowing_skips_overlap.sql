-- 0155 A policy revision that only ends earlier cannot create a tie, so it does not meet the no-overlap check (FR-024; BR-010; ZT09; DF05).
-- 0110, 0115 and 0116 re-ran that check on every change to a revision's state or period. A tie recorded before those guards then could not
-- be ended through the route: retiring either side still overlaps the other over the days already past, so the retirement itself was
-- refused (422 RULE_VIOLATION) and the tie stayed for good. 0081 already answered this for confirmation policies; this is the same rule.
--
-- The check is skipped only when the revision was in force, keeps its start, and has an end no later than before. Anything else still
-- meets it: a later end, removing the end, a start moved either way, a draft being activated, a revision retired without an end being
-- brought back. A tie's past days stay ambiguous on purpose: what was recorded is not rewritten here, so earlier dates keep refusing and
-- only dates from the new end on are decided.
--
-- Safe on an upgrade: function bodies only, no row is read or written, so a stored tie neither stops the migration nor changes.

create function hrms_policy_only_narrows(old_state text, old_from date, old_to date, new_from date, new_to date) returns boolean language sql immutable as $$
  select (old_state = 'ACTIVE' or (old_state = 'RETIRED' and old_to is not null))
     and new_from = old_from
     and new_to is not null
     and (old_to is null or new_to <= old_to)
$$;

create or replace function hrms_leave_policy_no_overlap() returns trigger language plpgsql as $$
begin
  if new.state = 'DRAFT' or (new.state = 'RETIRED' and new.effective_to is null) then
    return null;
  end if;
  if tg_op = 'UPDATE' then
    if hrms_policy_only_narrows(old.state, old.effective_from, old.effective_to, new.effective_from, new.effective_to) then
      return null;
    end if;
  end if;
  perform 1 from leave_type where company_id = new.company_id and id = new.leave_type_id for no key update;
  if exists (select 1 from hrms_leave_policy_conflicts(new.company_id, new.id)) then
    raise exception 'leave policy % overlaps another revision of its leave type at the same priority', new.id using errcode = '23514';
  end if;
  return null;
end $$;

create or replace function hrms_attendance_policy_no_overlap() returns trigger language plpgsql as $$
begin
  if new.state = 'DRAFT' or (new.state = 'RETIRED' and new.effective_to is null) then
    return null;
  end if;
  if tg_op = 'UPDATE' then
    if hrms_policy_only_narrows(old.state, old.effective_from, old.effective_to, new.effective_from, new.effective_to) then
      return null;
    end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('attendance:policy:' || new.company_id::text, 0));
  if exists (select 1 from hrms_attendance_policy_conflicts(new.company_id, new.id)) then
    raise exception 'attendance policy % overlaps another revision in force at the same priority', new.id using errcode = '23514';
  end if;
  return null;
end $$;

create or replace function hrms_expense_policy_no_overlap() returns trigger language plpgsql as $$
begin
  if new.state = 'DRAFT' or (new.state = 'RETIRED' and new.effective_to is null) then
    return null;
  end if;
  if tg_op = 'UPDATE' then
    if hrms_policy_only_narrows(old.state, old.effective_from, old.effective_to, new.effective_from, new.effective_to) then
      return null;
    end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('expense:policy:' || new.company_id::text, 0));
  if exists (select 1 from hrms_expense_policy_conflicts(new.company_id, new.id)) then
    raise exception 'expense policy % overlaps another revision in force', new.id using errcode = '23514';
  end if;
  return null;
end $$;
