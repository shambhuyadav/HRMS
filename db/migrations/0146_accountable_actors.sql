-- 0146 Accountable creators on the tables with a self-approval check (B1 "Required fields below are NOT NULL", line 2800; 9.2 "Created
-- by" R; C4; DQ-08). These checks let a row with no recorded creator pass "the approver is not the creator". The rest of B1
-- across the other tenant tables is open engineering work in the register, not done here.

-- 1. Two accounts that are not people. The system actor is who the scheduler and the notification dispatcher act as, passed
--    explicitly by the code that writes; nothing fills it in by default. The other says plainly that a creator was not recorded
--    before this migration: it does not claim the system created those rows, and an audit reader can tell the two apart.
--    Fixed ids, so the same statement holds in every cell. Neither can sign in or hold access: see 2.
create function hrms_is_non_person_actor(p_user uuid) returns boolean language sql immutable as $$
  select p_user in ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002')
$$;

insert into user_account (id, account_key, active) values
  ('00000000-0000-4000-8000-000000000001', 'hrms.system.actor', false),
  ('00000000-0000-4000-8000-000000000002', 'hrms.creator.not.recorded', false);

-- 2. They stay inactive and unchanged, and nothing can make them able to act. Every sign-in path creates a server-side session
--    (DF10), so refusing the session refuses the sign-in, whichever provider asked for it.
create function hrms_non_person_actor_fixed() returns trigger language plpgsql as $$
begin
  if hrms_is_non_person_actor(old.id) then
    raise exception 'a non-person actor account does not change' using errcode = '23514';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger user_account_non_person_fixed before update or delete on user_account for each row execute function hrms_non_person_actor_fixed();

create function hrms_person_only() returns trigger language plpgsql as $$
begin
  if hrms_is_non_person_actor((to_jsonb(new) ->> 'user_id')::uuid) then
    raise exception '% is for people; a non-person actor cannot hold one', tg_table_name using errcode = '23514';
  end if;
  return new;
end $$;
create trigger role_assignment_person_only before insert or update of user_id on role_assignment for each row execute function hrms_person_only();
create trigger user_session_person_only before insert on user_session for each row execute function hrms_person_only();
create trigger user_employee_link_person_only before insert or update of user_id on user_employee_link for each row execute function hrms_person_only();

-- 3. A stored row with no creator keeps every other value: its version and last-updated time are not touched, and a grant keeps its
--    bootstrapped marker. Which triggers are set aside is whole-table and only for this one statement. The upgrade log says how many.
do $$
declare
  t text;
  n bigint;
begin
  foreach t in array array['role_assignment', 'leave_policy', 'attendance_policy', 'expense_policy', 'biometric_mapping_revision', 'payroll_head_revision',
                           'payroll_calendar', 'payroll_paid_day_policy', 'payroll_hold_criterion', 'increment_cycle', 'tax_rule_pack'] loop
    execute format('alter table %I disable trigger user', t);
    execute format('update %I set created_by = %L where created_by is null', t, '00000000-0000-4000-8000-000000000002');
    get diagnostics n = row_count;
    execute format('alter table %I enable trigger user', t);
    if n > 0 then
      raise warning '% stored rows of % had no recorded creator; they now name hrms.creator.not.recorded', n, t;
    end if;
    execute format('alter table %I alter column created_by set not null', t);
  end loop;
end $$;

-- 4. With a creator always present the escape has no purpose. The approver or activator is never the creator, and never a
--    non-person. Stored rows satisfy this: the old check held wherever a creator was recorded, and the backfilled actor approved nothing.
do $$
declare
  r record;
begin
  for r in
    select con.conrelid::regclass::text as t, con.conname, case when pg_get_constraintdef(con.oid) like '%approved_by%' then 'approved_by' else 'activated_by' end as actor
      from pg_constraint con
     where con.contype = 'c' and pg_get_constraintdef(con.oid) like '%created_by IS NULL%'
       and con.conrelid::regclass::text = any (array['role_assignment', 'leave_policy', 'attendance_policy', 'expense_policy', 'biometric_mapping_revision', 'payroll_head_revision',
                                                     'payroll_calendar', 'payroll_paid_day_policy', 'payroll_hold_criterion', 'tax_rule_pack'])
  loop
    execute format('alter table %I drop constraint %I', r.t, r.conname);
    execute format('alter table %I add constraint %I check (%I is null or (%I <> created_by and not hrms_is_non_person_actor(%I)))', r.t, r.t || '_independent_actor', r.actor, r.actor, r.actor);
  end loop;
end $$;

alter table increment_cycle drop constraint increment_cycle_activation;
alter table increment_cycle add constraint increment_cycle_activation check (
  (activated_by is null) = (activated_at is null)
  and (active or activated_by is null)
  and (activated_by is null or (activated_by <> created_by and not hrms_is_non_person_actor(activated_by))));
