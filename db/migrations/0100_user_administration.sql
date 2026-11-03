-- 0100 User administration (FR-001; §5 System Administrator "approved user/role administration"; §5.1 User to employee;
-- DB007; DB009 "No overlapping links for user within company; employee belongs to company; link does not itself grant
-- permission").
--
-- access.link_user        link an existing account to an employee of the company, and end that link.
-- access.deactivate_user  deactivate or reactivate an account whose only live ties are in the company (a global account
--                         that also serves another company is refused: docs/03 records who decides that).
--
-- user_employee_link keeps its two EXCLUDE constraints (one employee per user, one user per employee at any date). A link
-- is ended, never deleted (0001): its user, employee and start are fixed and its end may only come earlier. A link
-- mistakenly made today must stop working today, so an end equal to the start is allowed: the period is empty, it is in
-- force on no date, it overlaps nothing and the record stays.

insert into permission (resource, action, field_group) values
  ('access', 'link_user', 'operational'),
  ('access', 'deactivate_user', 'operational');

alter table user_employee_link drop constraint user_employee_link_check;
alter table user_employee_link add constraint user_employee_link_period_check check (effective_to >= effective_from);

create function hrms_user_employee_link_guard() returns trigger language plpgsql as $$
begin
  if (new.user_id, new.employee_id, new.effective_from) is distinct from (old.user_id, old.employee_id, old.effective_from) then
    raise exception 'a user link keeps its user, employee and start; end it and make a new one' using errcode = '23514';
  end if;
  if old.effective_to is not null and (new.effective_to is null or new.effective_to > old.effective_to) then
    raise exception 'the end of a user link may only come earlier' using errcode = '23514';
  end if;
  return new;
end $$;

create trigger user_employee_link_guard before update on user_employee_link
  for each row execute function hrms_user_employee_link_guard();
create trigger user_employee_link_no_truncate before truncate on user_employee_link
  for each statement execute function hrms_no_truncate();
